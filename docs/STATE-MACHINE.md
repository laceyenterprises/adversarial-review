# Adversarial Review State Machine Notes

Quick reference for the two durable state machines in this module.

Use this when you want the control-plane picture without the full runbook.

---

## The important distinction

There are **two different ledgers**:

1. **Watcher delivery state** in SQLite: `data/reviews.db`
2. **Follow-up remediation queue state** in JSON files: `data/follow-up-jobs/*`

They interact, but they are not interchangeable.

- SQLite answers: **can this PR be reviewed / re-reviewed?**
- Queue files answer: **what remediation round is happening around the posted review?**

---

## End-to-end flow

```text
GitHub PR
  │
  ▼
watcher.mjs
  │ title validation + route selection
  ▼
reviewer.mjs
  │ review post succeeds
  ▼
reviews.db row -> posted
  │
  └─ create follow-up job -> data/follow-up-jobs/pending/<jobId>.json
                                │
                                ├─ follow-up:consume
                                ▼
                           in-progress
                                │
                                ├─ detached remediation worker runs
                                │
                                ├─ follow-up:reconcile
                                ▼
                           completed / failed / stopped
                                │
                                └─ if reply JSON says rereview requested=true:
                                     reviews.db row -> pending
                                     watcher can review again
```

---

## 1) Watcher delivery state machine

Source of truth:

```text
data/reviews.db
```

### Main statuses

| review_status | Meaning |
|---|---|
| `pending` | eligible for watcher review / re-review |
| `pending-upstream` | transient upstream/provider failure; parked behind the file-backed cascade backoff window, reclaimable by the normal claim once it expires (does not burn `review_attempts`) |
| `reviewing` | reviewer subprocess in flight; durable claim before spawn |
| `posted` | review posted successfully |
| `failed` | review attempt failed; eligible rows are auto-retried by the normal dispatch path on a later poll |
| `failed-orphan` | watcher restarted while a `reviewing` row was in flight and safe automatic recovery could not be proven — sticky, requires operator verification + `npm run retrigger-review` |
| `malformed` | title guardrail failure; terminal by design |

### Transitions

```text
new PR
  │
  ├─ malformed title
  │    └─ malformed
  │
  └─ valid tagged PR
       └─ pending
            │
            ├─ stmtMarkAttemptStarted (just before spawnReviewer)
            ▼
       reviewing
            │
            ├─ reviewer subprocess returns ok
            │    └─ posted
            │
            ├─ reviewer subprocess fails
            │    └─ failed
            │         └─ eligible retry: normal dispatch gates + stmtMarkAttemptStarted
            │              └─ reviewing
            │
            ├─ watcher restart while reviewing
            │    ├─ confirmed dead + no late review after bounded overdue recovery
            │    │    └─ failed
            │    └─ otherwise
            │         └─ failed-orphan   (sticky, operator-only recovery)
            │
            └─ accepted rereview request from follow-up reconciliation
                 └─ pending
```

### Notes

- `malformed` is intentionally sticky.
- A `failed` row is not reset by a standalone sweep. Its `failed_at` and
  `failure_message` remain visible until the watcher rediscovers that PR in an
  active repo, passes the normal non-drain/subject/follow-up/backoff/admission
  gates, passes the routing-tier readiness probe, and wins
  `stmtMarkAttemptStarted`. That atomic claim is the point where failure
  evidence is cleared because a replacement review pass is now durably
  `reviewing`.
- Fresh transient reviewer failures (`cascade`, `provider-overloaded`,
  `reviewer-timeout`, `launchctl-bootstrap`, and `daemon-bounce`) settle
  directly to `pending-upstream`, increment `infra_auto_recover_attempts`, and
  resume when the reviewer lane/routing tier recovers; they intentionally do
  not pass through the `failed` compare-and-swap recovery claim. Legacy or
  explicitly terminal infrastructure-class `failed` rows (`cascade`,
  `provider-overloaded`, `reviewer-timeout`, `launchctl-bootstrap`,
  reviewer-spawn `oauth-broken`, `quota-exhausted`, and
  `reviewer-command-failed` stored as `[unknown] Command failed...`) use the
  dedicated claim path that atomically promotes the row to `reviewing` and
  increments `infra_auto_recover_attempts` only if the row is still the same
  failed infrastructure class.
  `quota-exhausted` is held until the provider reset window clears before that
  claim is attempted: the watcher prefers
  `quota_reset_at_utc`, falls back to parsing the tagged `failure_message`, then
  falls back to a fixed window anchored to `failed_at` / `last_attempted_at`.
  `provider-overloaded` preserves HTTP 529/backend capacity failures separately
  from generic `cascade` so pipeline health can report provider instability
  without burning the normal review attempt budget.
  `deploy-wedge` rows are recorded as `pending-upstream` when main-catchup is
  frozen or its outage state file is unreadable; malformed JSON in
  `main-catchup/.state.json` is treated as `state-unreadable` and pauses reviews
  without consuming `review_attempts` or crashing the watcher.
  For `reviewer-command-failed`, the watcher first uses the persisted reviewer
  session/start evidence to query GitHub for a matching reviewer-bot review
  posted after the failed attempt started. If one exists, the watcher marks the
  row `posted`; if the proof cannot be performed, the row remains `failed`
  rather than retrying. Once the counter reaches the cap, the row stays `failed`
  for operator inspection. The counter resets after a successful posted review or
  an intentional re-review re-arm. `forbidden-fallback`, `failed-orphan`,
  `malformed`, inactive repos, closed/merged PRs, undiscovered PRs, active
  watcher drain, and active follow-up jobs are not auto-recovered by this path.
- **Quota re-arm surface (`bin/quota-rearm.mjs`).** Operators can run
  `npm run quota-rearm -- --repo <slug> --pr <n>` to release a stuck
  `quota-exhausted` failed row after verifying the provider window is clear. A
  successful re-arm moves the row to `pending`, clears `failed_at`,
  `failure_message`, `quota_reset_at_utc`, and reviewer lease/session fields, and
  resets `infra_auto_recover_attempts` to `0`. The command refuses missing rows,
  non-open PRs, `reviewing` rows, already pending rows as a no-op, and non-failed
  statuses such as `posted`, `malformed`, `failed-orphan`, and
  `pending-upstream`. `--force` bypasses only the quota-evidence check on an open
  `failed` row; it does not authorize rewriting posted reviews or unrelated
  statuses. The SQL update is a compare-and-swap against the failed row that was
  read, including stable failure/session fields, so concurrent watcher/operator
  changes surface as `state-changed` instead of clearing newer evidence.
- **Cancellation surface (`src/review-cancel.mjs`).** The canonical CLI for cancelling an in-flight reviewer is `node src/review-cancel.mjs --repo <slug> --pr <n> [--signal SIGTERM] [--allow-status <comma-list>] [reason]`. By default the CLI accepts only rows in `review_status='reviewing'` (the durable claim that a reviewer subprocess is in flight). Supported values for `--allow-status` are `reviewing`, `posted`, `failed`. The flag explicitly excludes `pending` (no subprocess to signal), `failed-orphan` (sticky operator-only recovery; use `npm run retrigger-review` instead), and `malformed` (terminal by design). The canonical surface MUST cover the extended cases so operators do not fall back to `sudo kill -KILL <pgid>` or hand-editing the row to fool the guard.
  - **`--allow-status posted`** covers the **post-merge race** observed 2026-05-30: a prior attempt's row had already transitioned to `posted` while the watcher had re-spawned a retry whose subprocess outlived the PR's own merge.
  - **`--allow-status failed`** covers the **draining-subprocess** shape: the subprocess errored (timeout, cleanup-phase exception) and flipped the row to `failed`, but the OS process is still alive — for example holding a file handle, an open Linear API session, or its own SIGTERM teardown timer. Distinct from `failed-orphan`: a `failed` row preserves the reviewer failure evidence for operator inspection unless it matches the bounded infrastructure-recovery classifier (`cascade`, `reviewer-timeout`, `launchctl-bootstrap`, reviewer-spawn `oauth-broken`, or `reviewer-command-failed` for stored `[unknown] Command failed...` rows). Only that dedicated infra claim may promote `failed → reviewing`; generic failed rows are not re-promoted by `stmtMarkAttemptStarted`. The CLI's PID-identity guard (`verifyPgidIdentity` start-time match) is what makes the kill safe if row state changes during cancellation, and the CLI re-fetches the row on `identity-unconfirmed` to surface the new state so the operator can target the live reviewer instead.
  - **Audit channel.** The cancellation receipt at `data/review-cancellations/<repo>-pr-<n>-<utc>.json` records the source `review.status`, the resolved `result`, and any `postSignalState` snapshot if the row transitioned mid-cancel. This receipt directory — **not** the SQLite row — is the canonical audit trail for cancels: `cancelActiveReview` runs read-only against `reviewed_prs` (`query_only = 1`), so a successful cancel against a `posted` or `failed` row leaves the row state unchanged. To find historical cancels for a PR after the fact: `ls data/review-cancellations/ | grep -F "pr-<n>"`, then read each JSON to see the source status, requestedBy, requestedAt, reason, and signal outcome.
- `failed-orphan` is intentionally sticky except for the bounded auto-reclaim path. It covers any restart-era session where the watcher cannot prove a safe handoff back to automation, including missing launch-time timeout metadata on legacy rows, a live matching reviewer PGID, a reviewer liveness probe whose `ps` session check is unknown, a live PGID without a stored `reviewer_session_uuid`, a live PGID that survives the bounded SIGTERM/SIGKILL recovery loop, or a non-transient GitHub probe failure that prevents safe orphan classification. A late GitHub review discovered during auto-reclaim is reconciled by marking the row `posted` so the same failed-orphan row does not trigger repeated live GitHub probes. Transient GitHub probe failures such as timeouts, rate limits, and 5xx responses leave the row in `reviewing` so the next watcher tick can retry instead of creating a sticky operator-only row. A failed-orphan row may be auto-reclaimed only after its persisted reviewer lease expires, the infrastructure recovery cap has room, and the watcher can prove the original reviewer is no longer live: either the process group is gone or the PGID is now occupied by a command line that does not contain the stored `reviewer_session_uuid`. Missing session UUIDs and transient `ps` failures are treated as unknown liveness and do not reclaim. Manual recovery remains:
  1. Inspect the GitHub PR. If a review was already posted by the reviewer bot, leave the row alone (the round is effectively done).
  2. If no orphan review is present, run `npm run retrigger-review --repo <slug> --pr <n> --reason "verified no orphan review"`. The reset clears the sticky state and re-arms `pending`.
- Steady-state recovery does not touch a newly claimed row merely because `reviewer_started_at` is still empty. Until the authoritative spawn callback persists `reviewer_started_at` and `reviewer_pgid`, `last_attempted_at + reviewer_timeout_ms` is the temporary guard window; only after that window expires may the row be reconciled as missing spawn metadata. If null-PGID recovery must probe GitHub and no historical start timestamp is available, the lookup omits the lower time bound rather than synthesizing `now`, so a review already posted by the orphan can still be recovered.
- Overdue orphan auto-retry is deliberately narrow. The watcher only attempts it when the row persisted the original launch timeout and an authoritative reviewer spawn timestamp, the orphan age exceeds that persisted timeout from the actual subprocess start, the process group is confirmed dead after the bounded recovery loop, and GitHub is reprobed over a short delayed window with no late review found. That same steady-state recovery path also settles the runtime reviewer run-state ledger before the SQLite row flips terminal. Any ambiguity falls back to sticky `failed-orphan` instead of launching a second reviewer.
- Re-review does **not** happen because of prose. It happens because reconciliation resets the row to `pending`.
- A PR can move from `posted` back to `pending` only via explicit recovery logic or a valid rereview request.

---

## 2) Follow-up remediation queue state machine

Source of truth:

```text
data/follow-up-jobs/
  pending/
  in-progress/
  completed/
  failed/
  stopped/
```

Directory = state.

### Main states

| Queue state | Meaning |
|---|---|
| `pending` | waiting for operator to consume |
| `in-progress` | claimed/spawned round exists |
| `completed` | round finished and rereview request was accepted |
| `failed` | launch/reconcile/artifact failure |
| `stopped` | bounded terminal stop |

### Transitions

```text
pending
  │
  ├─ follow-up:consume
  ▼
in-progress
  │
  ├─ worker still running during reconcile
  │    └─ in-progress
  │
  ├─ launch failure
  │    └─ failed
  │
  ├─ legacy job base branch cannot be proven
  │    └─ failed (base-branch-resolution-failed)
  │
  ├─ reconcile sees missing/invalid artifacts
  │    └─ failed
  │
  ├─ reconcile sees valid rereview request and contamination audit passes
  │    └─ completed
  │
  ├─ reconcile sees valid rereview request but contamination audit fails
  │    └─ failed (branch-contamination)
  │
  ├─ reconcile cannot complete contamination audit (fetch/cherry error)
  │    └─ failed (branch-contamination-audit-error)
  │
  ├─ reconcile sees no durable rereview request
  │    └─ stopped (no-progress)
  │
  └─ operator stop
       └─ stopped (operator-stop)

completed
  │
  ├─ operator requeue
  │    └─ pending
  │
  └─ max rounds guardrail trips
       └─ stopped (max-rounds-reached)

failed
  │
  ├─ operator requeue
  │    └─ pending
  │
  └─ max rounds guardrail trips
       └─ stopped (max-rounds-reached)
```

### Important nuance

`completed` does **not** mean:

- PR merged
- code approved
- work finished

It means:

- this remediation round ended successfully
- the rereview request was durable and accepted
- the watcher can pick the PR up again

---

## Rereview contract

The only normal rereview trigger is the remediation reply artifact:

```json
{
  "reReview": {
    "requested": true,
    "reason": "..."
  }
}
```

If that durable flag is absent or false:

- the queue does **not** fabricate another pass
- the job stops with `code = "no-progress"`

That conservatism is intentional.

If the flag is true, reconcile still runs the branch-contamination gate before resetting `reviews.db` back to `pending`. A contaminated branch does **not** produce a synthetic stop; it moves to durable `failed/` with `failure.code = "branch-contamination"` so operators have an audit trail and a retryable terminal record after they clean the branch.

Legacy durable jobs created before `baseBranch` was persisted are hydrated from GitHub before any worker prompt or reconcile audit uses the branch. If GitHub cannot prove the real PR base, the job fails with `base-branch-resolution-failed` rather than rebasing or auditing against `main` by default.

---

## MSM two-path merge authority (current)

> **Status: current.** This is the live closure model on AMA-enabled hosts
> (`roles.adversarial.merge_authority.enabled: true`). It supersedes the
> standing merge-agent closure path for normal PRs; merge-agent survives only
> as the operator-fallback lane (current-head `merge-agent-requested` label)
> and for hosts without AMA. Operational runbook:
> [`RUNBOOK-ama-closure.md`](RUNBOOK-ama-closure.md).

Once a review settles on the current head, each watcher tick routes closure
down exactly one of two paths:

| Path | When | What happens |
|---|---|---|
| **Hammer (common)** | Final review carries findings (blocking, or non-blocking under the default strict posture), the PR needs a rebase, or CI needs repair | The watcher dispatches exactly one hammer terminal-remediation worker (`templates/hammer-prompt.md`, via `src/ama/dispatch-closer.mjs`). The hammer remediates, rebases onto the current base, holds the required-checks-plus-changed-surface-tests merge bar, waits out GitHub required checks on the exact post-remediation head inside a bounded remote-CI window, and merges under its own lease with `--match-head-commit`. |
| **Daemon inline merge (rare)** | Final review is fully clean — zero blocking AND zero non-blocking findings, both classifications known — plus green required checks, a MERGEABLE PR, and a live head matching the reviewed head | The watcher daemon clicks merge inline through a bounded `gh pr merge --match-head-commit` subprocess under the shared merge lease (`src/ama/daemon-merge.mjs`). No agent is spawned. Dispositions: `merged`, `failed-closed` (no hammer spawned from this path), `deferred` (lease contention; retry next tick), `not-taken` (falls through to the hammer route). |

Key control points:

- **Shared predicate.** Both paths evaluate `evaluateMergeEligibility`
  (`src/ama/merge-eligibility.mjs`), which fails closed on empty required
  checks, non-mergeable/behind state, stale heads, and a missing lease — the
  two paths cannot drift apart on "may this PR merge right now?".
- **`strict_mode`** (default `true`): the daemon may inline-merge only
  zero-finding reviews. Explicitly setting it `false` permits daemon merge
  over *known non-blocking* findings only; blocking or unknown finding state
  still routes to the hammer.
- **`auto_hammer_on_eligibility_miss`** (default `false`): historical.
  It gated the auto-hammer dispatch when it was introduced, but since MSM-04
  the runtime no longer reads it — the hammer route keys on the configured
  `worker_class`/review-cycle exhaustion plus the hammer-remediable
  miss-reason classification. The key remains schema-accepted so existing
  configs validate.
- **Kill switch.** `autonomous_merge_execution_enabled: false` (followed by
  an adversarial-watcher bounce) disables BOTH paths: the watcher writes a
  fail-closed `autonomous-merge-execution-disabled` audit recording which
  path would have run, and leaves the PR for manual operator intervention.
- **No re-hammer loop.** A stale head does not spawn a second hammer chain;
  the daemon records `stale-head` as permanent for that validated head and
  the new head enters its own review lifecycle.

---

## 3) Fast-merge skip lane

Source of truth:

```text
data/reviews.db.reviewed_prs
```

Fast-merge is a watcher-owned bypass lane for narrowly allowlisted PR labels.
It is gated by `FML_WATCHER_SKIP_ENABLED=true`; when the flag is false, the
watcher records audit-only `would-have-skipped` entries and still runs normal
first-pass adversarial review.

### Additional watcher states

| Field | Value | Meaning |
|---|---|---|
| `pr_state` | `fast_merge_skipped` | watcher deliberately skipped first-pass review for an authorized head |
| `pr_state` | `fast_merge_merged` | merge-agent merged the authorized fast-merge head |
| `pr_state` | `fast_merge_closed` | PR closed without merging after entering the fast-merge lane |
| `pr_state` | `fast_merge_blocked` | merge-agent or watcher refused to complete the fast-merge lane |
| `review_status` | `fast_merge_skipped` | first-pass review was intentionally bypassed for the stored authorized head |
| `fast_merge_audit_status` | `pending` | a fast-merge state transition happened but its audit JSON still needs retry |
| `fast_merge_audit_status` | `written` | the audit JSON for the latest fast-merge transition was persisted |

### Authorization rule

The label alone is never the authority. The watcher may set
`fast_merge_authorized_head_sha` only when all of the following are true:

- A current allowlisted `fast-merge:*` label is present and `fast-merge-veto` is absent.
- The current PR head SHA can be fetched successfully.
- The issue timeline both records the authorizing label and corroborates the
  authorized head SHA by pairing the most recent allowlisted-operator label
  event with the live PR head from `pulls.get`.
- The changed-file list matches the allowlisted category shape. For example,
  `fast-merge:docs` is limited to documentation file extensions,
  `fast-merge:submodule-bump` is limited to known gitlink paths, and
  `fast-merge:spec-hash-rebind` only allows a tiny spec-lock/spec-hash rebind.
- Any commit, force-push, or head-restore event at or after the label
  invalidates the authorization.

If that proof is missing, the watcher fails closed to the normal review path.
When the fast-merge label is later removed, or `fast-merge-veto` appears, the
watcher resets the row back to normal first-pass review and records the recovery
transition in the fast-merge audit stream. Recovery scans are bounded per tick
to keep skipped-row cleanup from monopolizing the watcher.

`reviewed_at` stores when the watcher processed the skip. The label application
time remains in the audit entry as `authorized_at`; do not use `reviewed_at` as
the operator-label timestamp.

### Merge-agent contract

> **Historical naming note.** This subsection describes the fast-merge
> bypass lane's close path only. It predates the MSM two-path merge
> authority above and is NOT the normal-PR closure authority; under AMA,
> an active fast-merge state on a PR is fail-closed for the MSM paths
> (`fast-merge-state-unsupported`) and closes through this dedicated lane
> instead. Kept as-is because the lane and its states remain live.

`fast_merge_authorized_head_sha` is the commit the operator effectively approved
for the bypass lane. The follow-up daemon now actively consumes
`fast_merge_skipped` rows and closes them through the fast-merge path:

- it re-checks the live PR head, the live fast-merge authorization label, and `fast-merge-veto`,
- summarizes `gh pr checks --json name,state,bucket,workflow,link` output for pending/failed/successful CI,
- re-summarizes checks in the immediate pre-merge window,
- merges with `gh pr merge --squash --admin --delete-branch --match-head-commit <authorizedHeadSha>`,
- records `fast_merge_merged`, `fast_merge_closed`, or `fast_merge_blocked`,
- leaves retryable GitHub merge refusals in `fast_merge_skipped` while writing
  the refusal reason to the row's failure fields for live operator visibility,
- and requeues normal first-pass review when the head changed, veto appeared, or the authorization label was removed.

Before recording `fast_merge_blocked` on a merge error, the daemon must re-fetch
PR state; if GitHub already shows the PR merged, the durable state becomes
`fast_merge_merged` instead so partial merge success cannot be misreported as a
blocked refusal. If GitHub instead refused the merge but the PR remains open at
the authorized head, the row remains `fast_merge_skipped` for a later retry and
its failure fields carry the refusal reason. Fast-merge audit JSON is stored separately under
`data/fast-merge-audits/`; it is not part of the reviewer runtime
`data/reviewer-runs/` ledger. Skip and close records share the directory but
carry distinct audit-type discriminators, and terminal close-path audit failures
leave `fast_merge_audit_status='pending'` on the row so the watcher retry lane
can re-emit the audit.

---

## 4) Reviewer body capture and merge closeouts

Source of truth:

```text
data/reviews.db.reviewer_passes
data/reviews.db.pr_merge_closeouts
```

Reviewer-pass body capture is additive state on `reviewer_passes`:

| Field | Meaning |
|---|---|
| `verdict` | Normalized reviewer verdict: `approved`, `comment-only`, `request-changes`, or `dismissed`; pending GitHub reviews are not persisted as captured bodies |
| `body_md` | Markdown body captured from the GitHub review/comment artifact |
| `gh_comment_id` | GitHub comment or review artifact identifier; non-null values are unique |
| `body_captured_at` | Time the body scraper captured `body_md` for that pass |

The review poster treats a captured body for the same repo, PR, reviewed head,
reviewer model, and pass kind as its durable post checkpoint. If reviewed-
attestation signing or recording fails after that checkpoint, a watcher retry
skips the GitHub mutation, reuses the stored body rather than a newly generated
body, and resumes the attestation path. Signing uses the shipped flag-based
`hq attest sign` contract; the verified result is then persisted through the
owner-context `hq attest record --payload -` bridge. Signer output is accepted
only when the signed envelope preserves the payload exactly and binds
`signature.subject` to the reviewer identity; cryptographic acceptance is
delegated fail-closed to `hq attest record`.

`pr_merge_closeouts` tracks the post-merge closeout scrape/post lifecycle for a
single `(repo, pr_number)`:

| Field | Meaning |
|---|---|
| `created_at` | Row creation time for age-based triage before any stage timestamp is set |
| `closeout_body_md` | Markdown body that will be, or was, posted as the merge closeout |
| `closeout_authors_json` | JSON array of GitHub authors attributed in the closeout |
| `closeout_posted_at` | Time the closeout comment was posted |
| `body_captured_at` | Time the merge-closeout body was scraped/captured |
| `scrape_last_checked_at` | Last time the scraper checked the PR closeout state |
| `empty_confirmed_at` | Time the scraper confirmed no closeout body was available |
| `merged_at` | GitHub `mergedAt` observed by the closeout scraper for scrape diagnostics; `reviewed_prs.merged_at` remains canonical for merged-state decisions |
| `gh_artifact_refs` | JSON array of GitHub artifacts used by the closeout, e.g. comment references |
| `scrape_attempt_count` | Count of failed scrape attempts persisted on the row for triage of chronic failures |
| `scrape_last_error` | Truncated error string from the most recent scrape attempt that failed |

Lifecycle:

1. A row is created when a merged PR becomes eligible for closeout capture.
2. The scraper records `scrape_last_checked_at` on every poll.
3. If a body is available, it records `closeout_body_md`,
   `closeout_authors_json`, `gh_artifact_refs`, and `body_captured_at`.
4. If no body is available and the scraper reaches its empty-result threshold,
   it records `empty_confirmed_at`.
5. When the closeout is posted, the poster records `closeout_posted_at`.

`closeout_authors_json` and `gh_artifact_refs` must be JSON arrays when present
and may only be set alongside `closeout_body_md`. `closeout_posted_at` also
requires a captured body. `empty_confirmed_at` is the mutually exclusive
no-body outcome and must not be combined with `closeout_body_md`.

The scrape-pending index is keyed by `scrape_last_checked_at` for rows whose
`empty_confirmed_at` and `closeout_posted_at` are both unset; consumers must use
that state instead of table-scanning all historical merged PRs.

Retention is intentionally indefinite until a closeout archive/prune job exists;
the scrape-pending index keeps active scans bounded while preserving historical
closeout evidence for audit reports.

`empty_confirmed_at` is **not** a terminal guillotine. Settled-empty rows
are kept observable on a slower cadence (default 1 hour between scrapes)
until the row is more than 24 hours past `merged_at`, so a late closeout
comment posted after the 10-minute settle window still has a path to
upgrade the row to `closeout_body_md`. The comment-window upper bound
matches: comments posted up to 24 hours after `merged_at` are eligible
for capture; past that the terminal-empty decision stands. The watcher
caps `listPendingMergeCloseouts` to 20 rows per tick (fresh debt first,
chronic failures last via `scrape_attempt_count`) and also bounds the
batch by a 60s wall-clock budget enforced between rows: once the budget
is spent the remaining rows are deferred to the next tick instead of
stalling `pollOnce` behind a serial `gh api --paginate` × retry budget
per row. Freshly-merged rows always come first via the pending-list
ordering, so what gets deferred under a chronic-failure backlog is the
chronic-failure tail, not new debt. Failed scrapes upsert a debt row
with `scrape_attempt_count` bumped and `scrape_last_error` populated so
chronic failures are triageable off the hot loop instead of being
retried silently every tick; the failure-debt persist itself is
wrapped in the same SQLITE_BUSY retry as the success path, so brief DB
contention cannot silently drop the attempt-count signal. When a row
later recovers and a non-null `closeout_body_md` is captured, the
upsert resets `scrape_attempt_count` to 0 and clears `scrape_last_error`
so triage queries can distinguish currently-broken rows from
previously-broken-now-fine rows. `gh` stderr classification is content-
sensitive: a parsed non-empty stdout is accepted even when stderr
carries a benign banner (update notice, deprecation, ratelimit warning,
"Note:" header), with the stderr logged at warn; only stderr matching
fatal patterns (`error:`, `gh:`, `HTTP 4xx/5xx`, `GraphQL`, auth
failures) or stderr alongside an empty parsed result trips the retry-
then-fail path. Individual non-JSON lines in `gh`'s stdout are skipped
with a warn and the surviving parsed entries are kept; only an all-
non-JSON stdout falls through to a parse-error retry.

---

## Failure/stop codes worth remembering

### Queue stop reasons

| Code | Meaning |
|---|---|
| `operator-stop` | human explicitly stopped the job |
| `no-progress` | worker did not leave a durable rereview request |
| `max-rounds-reached` | bounded loop cap hit |
| `stale-review-head` | consume-time stale-job guard: the PR head moved before this worker spawned |

### Common failure classes

| Class | Typical cause |
|---|---|
| launch failure | checkout/auth/workspace prep problem |
| base-branch-resolution-failed | legacy job is missing `baseBranch` and GitHub could not prove the real PR base |
| artifact failure | missing `codex-last-message.md` or invalid `remediation-reply.json` |
| branch-contamination | rereview audit found patch-equivalent commits already on `origin/<baseBranch>` |
| review failure | reviewer auth/path/token/runtime issue |
| malformed title | PR missing required creation-time tag |

---

## Operator quick checks

### Queue view

```bash
find data/follow-up-jobs -maxdepth 2 -type f -name '*.json' | sort
jq '.' data/follow-up-jobs/in-progress/<jobId>.json
```

### Workspace artifacts

```bash
ls -la "$HQ_ROOT/adversarial-review/follow-up-workspaces/<jobId>/.adversarial-follow-up/"
jq '.' "$HQ_ROOT/dispatch/remediation-replies/<storage-key>/remediation-reply.json"
```

### Watcher row

```bash
sqlite3 data/reviews.db "select repo,pr_number,review_status,pr_state,review_attempts,posted_at,failed_at,rereview_requested_at,rereview_reason from reviewed_prs order by id desc limit 20;"
```

---

## If something looks weird

Check in this order:

1. queue JSON
2. workspace artifacts
3. SQLite row
4. watcher logs
5. worker log

That order usually gets you to the truth fastest.
