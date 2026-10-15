# Data Model - Reviewer Cascade State

**Owner:** reviewer transient-failure backoff and route selection
**Store:** `data/cascade-state/`
**Source of truth:** `src/reviewer-cascade.mjs`
**Runtime surface:** `src/reviewer-cascade.mjs`, `src/watcher.mjs`, `src/reviewer-route-selection.mjs`, `src/review-pipeline-health.mjs`, `src/token-refresh-hold.mjs`

## Purpose

`data/cascade-state/` stores one durable JSON file per GitHub PR that has hit a
transient reviewer-spawn failure. The watcher consults this state before
claiming another reviewer attempt so provider outages, OAuth failures, reviewer
timeouts, and similar infrastructure failures do not burn
`reviewed_prs.review_attempts` or tight-loop on a struggling reviewer lane.

The file is PR-scoped, not reviewer-scoped. Its `nextRetryAfter` value holds
the PR against every eligible reviewer until the exponential backoff window
expires. Model-specific fields exist only to inform routing decisions about a
particular reviewer model once the PR-level hold is clear.

## Files

Directory: `data/cascade-state/`

| File | Shape | Contract |
|---|---|---|
| `<encodeURIComponent(repo)>__<prNumber>.json` | Cascade state object | Durable per-PR transient-failure state. The writer uses tmp+fsync+rename so readers never rely on a torn JSON file. Missing or unreadable files are treated as no cascade state. |

## State Object

| Field | Shape | Contract |
|---|---|---|
| `consecutiveTransientFailures` | number | PR-level consecutive transient failure count, clamped at the cascade failure cap. This drives the `1, 2, 4, 8, 15` minute backoff schedule. |
| `consecutiveCascadeFailures` | number | Legacy cascade-only count. Readers fold it into new counters when old state is encountered; new writes use `consecutiveTransientFailures`. |
| `transientFailureBreakdown` | object from failure class to count | PR-level, reviewer-agnostic failure totals. These counts explain the PR-level hold and remain flat across all reviewer models. |
| `transientFailureBreakdownByModel` | object from normalized model name to failure-class counts | Model-specific failure totals used only for model-specific routing and fallback decisions. These counts must not replace the flat PR-level hold counters. |
| `lastFailureModel` | string or null | Normalized reviewer model from the latest attributed failure, or the prior value when a new failure has no model attribution. |
| `lastFailureClass` | string | Normalized transient failure class from the latest recorded failure. Unknown classes normalize to `cascade`. |
| `lastFailureReason` | string or null | Trimmed diagnostic reason for the latest failure, when supplied. |
| `lastFailureAt` | string | ISO-8601 timestamp used as the failure anchor exposed by health reporting. Unusable input timestamps are replaced with the current time before writing. |
| `nextRetryAfter` | string | ISO-8601 PR-level backoff expiry. This is computed from the cascade backoff schedule, never from a provider-supplied reset hint. The one exception is a token-refresh hold (below), which sets it to `tokenRefreshHold.holdUntil`: never earlier than the backoff floor and never later than `tokenRefreshHold.maxHoldUntil`. |
| `providerRetryAfter` | string | Optional diagnostic provider reset hint. It is recorded only when supplied, is replaced on each write, and never gates reviewer dispatch. |
| `backoffMinutes` | number | Backoff duration used to compute `nextRetryAfter`. |
| `tokenRefreshHold` | object | Optional TOKDZ-01 hold written by `recordTokenRefreshHold` when the Claude reviewer refused a broker token that was waiting on a rotation (`token-refresh-pending`). Fields: `reviewerModel`, `startedAt` (first refusal of this hold), `lastRefusalAt`, `refusals`, `expectedRotationAt` (token expiry minus the bridge refresh window, or null when the refusal carried no lifetime), `holdUntil`, `maxHoldUntil` (`startedAt` plus `ADVERSARIAL_REVIEW_TOKEN_REFRESH_HOLD_MAX_MINUTES`, default 30), `maxHoldMs`. Carried forward across later transient-failure writes; dropped by `clearCascadeState`. |
| `capExhaustedAlertedAt` | string | Optional debounce marker for a cascade-cap-exhausted alert. |
| `capExhaustedAlert` | object | Optional diagnostic payload containing failure class, attempts, cap, and reason for the cap-exhausted alert. |
| `operatorDecisionAlertedHeadSha` | string or null | Optional per-head debounce key for operator-decision-required alerts. |
| `operatorDecisionAlertedAt` | string | Optional timestamp for the operator-decision-required alert debounce. |
| `operatorDecisionAlert` | object | Optional diagnostic payload for the operator-decision-required alert. |

## Mixed-State Semantics

- Old files may contain only `consecutiveCascadeFailures`. On the next failure,
  the writer treats that legacy value as the existing PR-level count and, when
  no `transientFailureBreakdown` exists yet, folds it into
  `transientFailureBreakdown.cascade` exactly once.
- Files without `transientFailureBreakdownByModel` are valid. Model-specific
  routing reads the attributed count for the selected model plus the flat-map
  remainder not already attributed to any model, so a mixed old/new deployment
  does not erase pre-upgrade failure evidence.
- `transientFailureBreakdown` remains the reviewer-agnostic PR-level hold
  counter. `transientFailureBreakdownByModel` is for model-specific route
  selection only; it must not change the PR-level backoff window.
- `lastFailureModel` is diagnostic and attribution-oriented. A failure without
  reviewer model attribution preserves the prior value instead of inventing a
  model owner for the new failure.
- Each `recordCascadeFailure` write replaces the whole state object except for
  fields explicitly carried forward by the source-of-truth module. A missing
  `providerRetryAfter` on a later write intentionally clears any older provider
  hint.

## Token-Refresh Holds

A `token-refresh-pending` refusal is a hold, not a failed attempt. The settle
path writes the row to `pending-upstream` through `MARK_TOKEN_REFRESH_HOLD_SQL`,
which charges neither `review_attempts` nor `infra_auto_recover_attempts`, so a
refusal can never walk a row to the terminal infra cap. The PR is parked until
the next expected rotation. When the hold releases, the `pending-upstream` row
is reclaimed by the generic attempt-start CAS. A legacy `failed` or same-head
`pending` token-refresh row, written before the hold accounting existed, is
reclaimed by `MARK_TOKEN_REFRESH_RECOVERY_ATTEMPT_STARTED_SQL`. That claim
neither checks nor charges `infra_auto_recover_attempts`, so it cannot strand a
row at the cap. Route selection keeps the held reviewer until
`maxHoldUntil`, then re-routes through the normal model-fallback path with
reason `token-refresh-hold-exhausted`. `token-refresh-pending` is not an
exec-fallback counting class, so repeated refusals inside the bound never
re-route on their own. A hold whose last refusal is older than the bound plus
one hour is stale and is ignored.
When a later refusal's cascade backoff floor crosses `maxHoldUntil`, the
PR-level `nextRetryAfter` is capped at `maxHoldUntil`. The held model retains
its backoff history, while route selection can choose an eligible fallback at
the bound.

## Operational Contract

- `shouldBackoffReviewerSpawn` returns a backoff when `nextRetryAfter` is in
  the future. Malformed `now` or `nextRetryAfter` timestamps fail closed and
  keep the PR parked rather than tight-looping.
- `clearCascadeState` removes the per-PR file after a successful reviewer path
  no longer needs the transient-failure hold.
- Operator-alert debounce fields share this per-PR file so alert state follows
  the same durable owner and atomic-write behavior as the backoff state.
- The files contain transient failure diagnostics and no secrets or review
  bodies.

## Repeated same-head timeouts (CASCADECAP-01)

`reviewerTimeout` records `{ headSha, reviewerBuildId, count, total, limit,
rearmAt }`. Normal settlement and the running-pass reaper both write it,
including terminal failures at the infrastructure cap. `count` measures timeouts
in the current head/build/re-arm series; `total` retains timeout evidence on the
head for dispatch fairness. Other transient failures preserve this object.

The default limit is two timeouts. A positive integer
`ADVERSARIAL_REVIEWER_TIMEOUT_SAME_HEAD_LIMIT` overrides it without a config
schema change. At the limit, the watcher parks the row before another claim,
persists `reviewer-timeout-repeated-same-head` in `failure_message` and the
existing review-failure decision record, and uses the existing operator-decision
alert path once per series. An expired cascade backoff cannot bypass this park.
The underlying `[reviewer-timeout]` classifier remains available to the existing
operator-label-gated timeout-exhaustion handoff; that gate is unchanged.

A new head starts a fresh budget. An explicit `retrigger-review:` operator
request newer than the recorded failure, or a different reviewer build, permits
one probe on the same head; a timeout from that probe parks again. Builds default
to a process-start content digest of reviewer sources, runtime adapters and
prompts. A deployment can supply `ADVERSARIAL_REVIEWER_BUILD_ID` instead. The
build is captured in pass metadata so reaping an old pass attributes its failure
to the build that actually ran. Legacy files use the failed row's head and flat
timeout count until a scoped failure is recorded.

Timeout retries yield to waiting first-pass and re-review candidates in the
shared WAKESTARVE-01 wake/wait ordering, including retries with retained wakes
or long waits. A partial discovery wave containing such a retry waits for full
discovery, so later subjects can enter that same ordering. Successful reviews
clear cascade state as before. Real upstream failures retain the existing
backoff and cap-override behavior.

Sibling audit:

- `pollonce-phases.mjs` and `review-state-statements.mjs`: the cascade override
  was the unbounded path for both first-pass and re-review timeouts. Both now
  consult the shared timeout budget, including a recheck before the claim CAS.
  Changed-build probes use that budget; their infra counter stays at its cap.
- `reviewer-spawn-settle.mjs` and `reviewer-pass-reaper.mjs`: both persist head
  and build evidence. The reaper now records terminal-at-cap timeouts too.
- `argus-security-drain.mjs` / `argus-reviewer-failures.mjs`: actual review and
  child timeouts are charged against `maxAttempts`. Only quota and unavailable
  identity deferrals avoid that counter, before model execution. Quota-only
  failed-job recovery requires quota-only history, so a timeout cannot use it.
  No behavior change needed.
- `follow-up-remediation.mjs` / `follow-up-jobs.mjs`: transient HQ dispatch
  failures and CI repair reuse a round but charge the job-scoped transient
  retry budget, which is checked before requeueing. Provider/identity holds
  before execution intentionally avoid charging it. No cascade override of
  that budget exists; no behavior change needed.
- Token-refresh and model-scoped credential-outage holds deliberately preserve
  their existing bounded probe/hold rules. Neither classification converts a
  recorded reviewer timeout into an unlimited retry.
- Additional remediation recoveries (`remediation-missing-artifact.mjs`,
  `remediation-claimed-requeue.mjs`, `remediation-worker-resume.mjs`, and the
  stale-claim sweep) check the same transient budget before requeueing.
  `remediation-round-accounting.mjs` can refund an infrastructure failure
  without charging that budget, but only once per round and within the existing
  PR-wide infrastructure-refund limit. These remain unchanged.
- `reviewer-harness.mjs` has an internal transient Gemini subprocess ladder.
  Its fixed retry-delay array bounds retries inside one reviewer attempt;
  it cannot override the watcher's head/build park. It remains unchanged.
