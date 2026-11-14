# CLOSERREREVIEWRACE-01

## Summary

Defer automatic review while the active closer owns the exact published or
leased head, including a rebase without closer trailers. Serialize the remote
publication and its ownership record with reviewer ownership reads. Preserve
explicit operator review requests and normal review of unrelated heads.

Exhausted no-merge closers and ordinary follow-up pre-claim cap stops durably
enroll a successor request for the head and refusing review. The watcher uses
the existing final-fix-all work order and its deduplication, or persists and
alerts a typed ownerless refusal. Strict findings remediation and merge
eligibility remain unchanged.

An exit before completing the close retains the existing bounded retry,
refund and cap-alert executor. A confirmed no-merge decision or `no_work_done`
with exhausted remediation rounds takes the successor path after terminal
worker cleanup and accounting.

## Interface changes

Publication scheduling reasons are `active-closer-published-head`,
`active-closer-merge-lease`, `closer-publication-in-progress` and
`closer-publication-unconfirmed`. The last two are probe deferrals and confer
no head ownership or merge authority. API publication, server rebases and the
Git fallback share the publication barrier. Merged lease release ends custody
immediately; controller exit/death and the bounded receipt lifetime also end it.
Probe deferrals keep automatic requests pending; only exact closer ownership
restores the posted review for closure.

Two local stores are documented in the canonical data-model docs and catalog
fragment: hammer publication ownership and closer successor custody.
Successor states are `successor-pending`, `successor-enrolled` and
`ownerless-closer-no-merge`. Refusals use the existing closure-wait alert surface
with wait class `closer-successor`; no new config, CI check or override exists.

## Race window

Previously, publication made a rebased worker head visible before the closer
posted `HAM-Validated-Head`. Neither that audit nor a closer commit identity
was available when the watcher decided whether to spawn a reviewer.

Now the closer takes a PR publication lock and durably writes intent before
publishing. A Git head is recorded before push. API-created and server-rebased
heads are recorded from the mutation result before releasing the lock; an
old-head acknowledgment retains the lock through visibility polling and the
existing full-tree replay proof. The reviewer-spawn ownership read takes the
same lock, so it either defers publication in progress or sees the exact head
record. Ambiguous mutation outcomes retain a typed probe deferral until the
controller ends. These records never certify findings or authorize merge.

## Verification

Validation uses synthetic offline fixtures and bounded worker validation
commands requesting 600 seconds, with the prescribed netguard environment on
test commands.

- `npm run lint`: zero errors; existing warnings remain.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed.
- `shellcheck -S error` on both rendered modified shell phases: passed.
- Scoped `node --test` runs passed: the 15 ticket regressions, 180 watcher
  claim-loop cases, 332 closer dispatch cases, 281 retry-cap cases, 125
  ownerless/retry cases, publication CLI/shell fixtures, final-cap handoff,
  final-fix-all lane, review-cycle cap and state-machine smoke suites.
- `npm test` was run offline with all test files selected. It reached the
  repository runner's fixed 900-second limit. Its observed watcher fixture
  failures were corrected, and the full 180-case watcher file then passed.
  No full-suite pass is claimed.
