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
Git fallback share the publication barrier. Merged lease release attempts to end
custody immediately; retirement errors warn without failing the settled release.
Controller exit/death and the bounded receipt lifetime also end custody.
Probe deferrals keep automatic requests pending; only exact closer ownership
restores the posted review for closure.

Two local stores are documented in the canonical data-model docs and catalog
fragment: hammer publication ownership and closer successor custody.
Successor states are `successor-pending`, `successor-enrolled` and
`ownerless-closer-no-merge`. Refusals use the existing closure-wait alert surface
with wait class `closer-successor`; no new config, CI check or override exists.
Requests recreate a receipt removed before its locked read. Settlement of a
missing receipt returns without dispatch or alert. Store schemas are unchanged.

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

Final comment-only remediation adds offline regressions for receipt removal
before request/settlement locked reads and merged CLI release with absent,
ready, locked and unreadable publication receipts. `runRelease` already declares
and validates `pr` at the reviewed head; the CLI fixtures pin the alleged
ReferenceError path without changing that valid identifier.

Final-round results:

- `node test/run-tests.mjs test/closerrereviewrace-01.test.mjs test/ama-merge-lease-cli.test.mjs`:
  all 80 tests passed; the new cases reproduced four failures before the fixes.
- `node test/run-tests.mjs test/smv.test.mjs`: all 11 tests passed, including
  the disposable smoke, after reviewing the guards and refreshing the successor
  source projection. The lifecycle graph is unchanged.
- `npm run lint`: zero errors (149 existing warnings).
- `npm run typecheck:contracts` and `bash demo/research-finding-walkthrough.sh`:
  passed.
- `node scripts/validate-data-model-catalog.mjs`: validated 98 entries.
- `git diff --check`: passed. Full-suite validation is deferred to PR-head CI.

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
- An additional affected-module run completed 9,603 tests: 9,598 passed,
  three skipped and two retry-accounting regressions failed. Both were fixed;
  the complete 14-case retry regression file then passed. A separate watcher
  consumer batch passed all 555 tests.
- `npm test` was run offline with all test files selected. It reached the
  repository runner's fixed 900-second limit. Its observed watcher fixture
  failures were corrected, and the full 180-case watcher file then passed.
  No full-suite pass is claimed.

## HAM CI repair

Closer dispatch now consumes `dispatchContext.settledReview`, preserving the
canonical snapshot through orchestration instead of projecting its review body
in the orchestration decision scope. Successor enrollment still receives the
same refusing review. No external interface or persistent schema changes.
The CDM audit reports zero findings without an allowlist exemption.
Targeted validation covers the CDM guard, successor custody, merged lease
release and closer dispatch regressions; exact-head CI remains authoritative.

HAM canonical changed-surface validation passed all 4,505 tests in 106 files.
Lint passed with zero errors (149 existing warnings), contract typechecking and
the offline byte-equivalence demo passed, and all 98 catalog entries validated.
