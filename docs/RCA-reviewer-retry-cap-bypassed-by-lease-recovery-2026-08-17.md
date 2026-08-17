# RCA — reviewer retry caps silently bypassed by lease recovery

**Date:** 2026-08-17
**Severity:** high (unbounded reviewer respawn; a PR held ~6h with no review)
**Surface:** `src/pollonce-phases.mjs`, `src/reviewer-spawn-settle.mjs`, `src/review-state-db.mjs`
**Worked example:** `laceyenterprises/agent-os#5486` (FSA-03, a 108-file / −19,854-line deletion)

## Symptom

`agent-os#5486` sat for roughly six hours with **no review posted at all**. The
watcher was not idle — it was respawning the reviewer continuously:

```
[reviewer:5486] stdout (failure-class=unknown): [reviewer] Starting review: …#5486 model=gemini
[watcher] Reviewer unknown-class failure on #5486; counting against attempt budget (64/3)
{"event":"watcher.no_progress","pollsSinceLastSpawn":3,"samplePRs":["laceyenterprises/agent-os#5486"]}
```

Measured over the whole window:

| | |
|---|---|
| reviewer spawns | **138** |
| distinct heads | **1** (`dbc9e5b3b1bf`) |
| failure classes | **138 × `unknown`** |
| verdicts posted | **0** |
| `retry cap exhausted` log lines | **0** |
| configured cap | `REVIEW_UNKNOWN_FAILURE_MAX_RETRIES = 3` |

Same input, same failure, no progress, retried 46× past a cap of 3. The log line
`(64/3)` reported a budget that nothing enforced.

## Root cause

`settleReviewerFailure` chooses between two terminal statements, and they differ
in exactly the field every retry cap keys on:

```sql
-- src/review-state-db.mjs
stmtMarkFailed          SET review_status = 'failed' , failed_at = ?, review_attempts = review_attempts + 1
stmtReleaseReviewLease  SET review_status = 'pending', failed_at = ?, review_attempts = review_attempts + 1
```

```js
// src/reviewer-spawn-settle.mjs
const terminalFailureStatement = leaseRecoveryEnabled
  ? statements.releaseReviewLease   // <-- writes 'pending'
  : statements.markFailed;          // <-- writes 'failed'
```

Every gate in `pollonce-phases.mjs` required `review_status === 'failed'`:

```js
const infraRecoveryClass  = current?.review_status === 'failed' ? … : null;
const unknownFailureClass = current?.review_status === 'failed' && !infraRecoveryClass ? … : null;
const populationRetry     = current?.review_status === 'failed' && … ;
if (current?.review_status === 'failed' && … && !unknownFailureRetryable && …) { return; }
```

With `REVIEWER_LEASE_RECOVERY_ENABLED` on, a terminal reviewer failure lands as
**`'pending'`**. So:

- `review_attempts` incremented on every failure — which is why the log could
  print `64/3`
- **no gate ever read it**, because the status was never `'failed'`
- each poll saw an ordinary pending review and spawned again, forever

The retry caps were not missing, misconfigured, or too high. They were
**unreachable**. `review_attempts` became a decorative counter.

Both statements set `failed_at` and `failure_message`, so the failure evidence
was present the whole time — only the status discriminator was lost.

## Why it went unnoticed

- The log *looks* like enforcement. `counting against attempt budget (64/3)` reads
  as a cap doing its job; nothing says the number is never checked.
- The failing PR was large and unusual, so "the reviewer struggles on a
  19,854-line diff" was an available and plausible story that stopped inquiry at
  the symptom.
- Lease recovery is the correct behaviour in its own right — releasing the lease
  lets another worker retry. The bug is not that it releases; it is that
  releasing erased the only signal the caps consumed.
- `watcher.no_progress` fired 20 times naming this PR. That is the alarm for this
  condition and it was working; it was read as "the queue is quiet".

## Fix

Introduce `reviewRowInTerminalFailureState(row, currentHeadSha)` and use it in
place of the four `review_status === 'failed'` checks. A row is in a terminal
failure state when it is `'failed'`, **or** when it is `'pending'` with
`failed_at` set, `review_attempts > 0`, and `reviewer_head_sha` still equal to the
head being considered. When such a lease-released pending row exhausts its retry
cap, finalize it to `failed` without incrementing attempts so the evidence is
visible and the row stops polling as pending work.

The head comparison is what keeps this narrow, and it is the property most worth
preserving: **a lease-released row whose head has moved is a legitimate fresh
review** and must not inherit the previous attempt count. Without that check, one
bad commit would poison the budget for every later commit on the same PR.

Where head information is absent the helper returns `false` — failing *open*. We
cannot prove the row is stuck on the same input, and wrongly capping would strand
a reviewable PR, which is a worse failure than one extra spawn.

## What this does not fix

The reviewer still **crashes** on this input — `failure-class=unknown` with no
captured error, dying immediately after printing `Starting review`. That is
consistent with failing to build a prompt from a very large diff, but the logs
record no size or token error, so it is unproven and tracked separately.

Note the contrast worth chasing there: on `#5468`/`#5470` the watcher *detected*
`oversizedAgyPromptBytes: 336421 > 262144` and rerouted to codex. On `#5486`
`hosted-reviewer-selection` stayed on gemini and never rerouted. Whatever guard
catches the oversize case did not fire on this path.

This RCA bounds the blast radius — a crash-looping reviewer now stops after 3
attempts, finalizes the row as failed, and leaves evidence intact — rather than
making the underlying crash go away.

## Evidence

- 138 spawns / 1 head / 138 `unknown` / 0 verdicts / 0 cap-exhausted lines,
  from `adversarial-watcher.log`
- `stmtMarkFailed` vs `stmtReleaseReviewLease` in `src/review-state-db.mjs`
- the four `review_status === 'failed'` gates in `src/pollonce-phases.mjs`
- `test/reviewer-lease-release-retry-cap.test.mjs` pins both directions: the
  lease-released same-head row now counts, and a moved head still does not
