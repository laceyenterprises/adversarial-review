# CLOSERRETRYREFUND-01

## Summary

Closer attempts that a closer fault ended no longer use up the PR's closer
retry budget. A `retry-exhausted` PR always has an executor. An exhausted budget
no longer hides a zero-finding exact-head review from the daemon.

Before this change, a fleet-wide closer fault let one PR's attempts fill its
per-PR closer budget. The fault (every merge step stopped at
`predicate-verdict-unavailable`, a `closer`/`infrastructure`-origin stop) left
behind charges that the existing refunds never saw:

- A deferred park is refunded only when the closer re-observes the ended launch.
  Once the budget read exhausted, the shared decision became R07
  `hammer/closure-recovery`, and the closer was fenced by
  `closure-decision-mismatch` before it reached that refund.
- A not-booted closer that DAEMONSUPERSEDE-01 cancelled stayed charged.
- The R07 executor (`refundInconclusiveExhaustion`) refunded only when every
  open charge was listed in the owner's inconclusive record. Neither case above
  was listed, so it paged and then repeated `closure-decision-mismatch` on every
  poll.
- The cap row reselected the daemon only for a review that posted after the
  cap. A zero-finding review that had already posted stayed shadowed.

## Behaviour

- **One refund rule, per charge.** A charge is a fault, not an adjudication,
  when its launch is listed in the owner's inconclusive record, or when every
  stop that launch wrote to the AMA audit has `closer` or `infrastructure`
  origin. The audit is read at the charge's head and at the decision head, so a
  closer that pushed a remediation head before its merge step failed is
  covered. Each fault charge is refunded once, by launch id, and recorded as an
  owned retry. The existing INCONCLUSIVERETRY-01b backoff then paces the
  re-armed closer, so a persistent fault cannot spin. A charge stays real if it
  has any `world` stop, no audit, an unreadable audit or an unknown reason. The
  executor applies this rule whenever it runs, including after a deploy, so it
  also covers a budget spent before a fix.
- **Revision release.** Each owned retry entry stamps `REVIEW_SERVICE_REVISION`.
  A different running revision releases that head's backoff once: the first
  closer after the fixing deploy runs at once.
- **Supersession is refunded.** `supersedeNotBootedCloser` records the cancelled
  launch in the owner's record and refunds its charge.
- **Typed terminal state.** If real attempts still spend the budget, the pass
  result reason is `closure-retry-exhausted` or `closure-lifetime-exhausted`.
  The result carries `closureTerminal: { state, headSha, owner: 'operator',
  realAttempts, recommendedAction }` and one page. A fault refund reports
  `closure-budget-refunded`. `hq merge-agent rescue --apply` runs the same
  executor, so it refunds fault charges or reports the typed state.
- **The zero-finding path is not shadowed.** In `src/pr-next-action.mjs` the
  R07 cap rows supersede to the R15 daemon row for a zero-finding (none
  blocking, none non-blocking or demoted, both known) exact-head review on a
  green MERGEABLE head, whenever it posted (ref
  `budget-superseded-by-zero-finding-review`). Any finding, an unknown count, a
  stale head or a daemon accountability refusal on this head keeps the budget
  executor in charge. strict_mode is unchanged. The daemon still proves every
  merge predicate, including worker identity, under its lease.

## Interface changes

- `refundInconclusiveExhaustion` accepts `headSha`, `hqRoot`, `readAuditImpl`
  and `recordRetryImpl`. It returns `fault-charges-refunded` (with
  `realAttempts` and `faultLaunches`) as well as the existing reasons.
- `escalateClosureBudget` accepts `hqRoot` (default `resolveHqRoot(env)`). It
  sets `reason`, `priorReason` and, when real attempts spend the budget,
  `closureTerminal`. New export: `CLOSURE_BUDGET_REFUNDED_REASON`.
- `recordCloserInconclusiveRetry` and `evaluateCloserInconclusiveRetryGate`
  accept `reviewServiceRevision`. The gate returns `revisionChanged`. Entries
  gain an optional `reviewServiceRevision`
  (`docs/data-model/closer-inconclusive-retries.md`).
- `supersedeNotBootedCloser` accepts `recordRetryImpl` and `refundImpl`, and
  the `ama.closer_superseded` event gains `refunded`.
- No configuration key, CI check, gate, ratchet, override label or strict-mode
  change. The state graph, decision rows and SMV declarations are unchanged.

## Verification

- `test/closerretryrefund-01.test.mjs` (new, 12 tests) covers:
  - three `predicate-verdict-unavailable` closers, then a revision change:
    refunded, backoff released once, one closer re-armed;
  - a remediation head pushed before the merge step failed;
  - genuine PR-attributed failures still exhaust the budget and publish the
    typed state;
  - per-charge refund among real charges;
  - no or unreadable audit stays real;
  - supersession refund;
  - the zero-finding daemon row and its holds;
  - an end-to-end daemon merge through `maybeDispatchAmaClosureFor` with an
    exhausted budget.

  Against an unmodified base archive, 8 of the 12 fail, all behavioural. The 4
  guard tests pass on both.
- Existing suites:
  - Updated, keeping their intent with a one-finding review:
    `pr-next-action`, `closer-next-action`, `hammer-wake-next-action`,
    `recovery-deadline` and `inconclusiveretry-01b` (now two real charges plus
    one fault).
  - All 105 suites that import the touched modules were run one file at a time.
    Nine files are red identically on base: `ama-closer-lease-failed-without-merge-reclaim`,
    `ama-pre-receipt-intent`, `ciblockham-03`, `hamclose-ownership`,
    `hamrace-mutual-exclusion`, `hamrefund-01`, `ownerproof-review-recovery`,
    `remconflict-01` and `review-pipeline-health`. In `smv`, only the
    load-flaky clean smoke is red, as on base.
- `npm run lint` (0 errors), `npm run typecheck:contracts` and
  `bash demo/research-finding-walkthrough.sh` pass.
