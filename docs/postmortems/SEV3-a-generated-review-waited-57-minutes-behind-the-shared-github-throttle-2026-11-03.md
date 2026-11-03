# SEV3: a generated review waited 57 minutes behind the shared GitHub throttle before posting

Contract: REVPOSTSTALL-01. Ticket: LAC-2151 (parent LAC-2132; project
fleet-incident-recovery-20261002). Date: 2026-11-03.
Status: source fix only. Review, exact-head CI, merge, deployment, the loaded
reviewer process and the next organic stall are separate acceptance gates.
LAC-2075 (budget incident) may be related; that relation is not established.

## Confirmed witness

All times are UTC. Evidence was read-only: sanitized run-state, side-channel
logs, API-call telemetry and throttle state from the deployed checkout. No
token, reattach handle or broker material was read or reproduced.

| Time | Evidence |
|---|---|
| 07:27:06 | `data/reviewer-runs/d47f5fa2-ef72-4246-88ae-9abdc967d953.json`: PR 1700, head `b2c5172002a3f090d6e97f062ef35b4f5ddd7ecc`, gemini, `first-pass`, attempt 1, PGID 57605, state `heartbeating`; `lastHeartbeatAt` stays at spawn time. |
| 07:30:35 | `.stdout`: `Review generated (3785 chars)`, with no later line until 08:27. |
| 07:30:35.529 | `data/api-call-log/2026-11-03.jsonl`: `rate_limit_throttle_seconds`, `resource=core`, `credential=default`, `remaining_at_activation=59`, `floor=200`, `reset_at=08:27:23`, sleep 3,407 s. |
| ~07:50 | No public review (rescue observation). |
| 08:27:23.801 | The process wakes and its next log lines appear. `Verdict mode ... enforce` follows a `WARN: failed to resolve advisory-only label ... Bad credentials (HTTP 401)`. |
| 08:27:25 | GitHub: one `COMMENTED` review by `lacey-gemini-reviewer[bot]` on `b2c5172…`, the only review at that head. |
| 08:27:32 | Run record `completed`. |

The telemetry row carries no PID. It is attributed to this process by time:
the stall began in the same second as `Review generated` and ended at that
row's `reset_at`. The code path matches. After `Review generated`,
`fetchCurrentHeadVerdictMode` reaches `fetchPullRequestHeadAndState`, whose
adapter and GraphQL reads call the unscoped
`awaitThrottleIfNeeded('core'|'graphql')` against the shared `default`
credential bucket. Below the floor, an unscoped caller sleeps until reset with
no child process and no output. `cli-direct` intentionally sets no progress
timeout for this wrapper ("silent posting, throttle"). The only bounds were the
Gemini process deadline and the parent timer, and either would have discarded
the finished review.

Consequences once the process woke, all from existing behaviour:

- The bot token adopted at 07:30:35 had expired. The verdict-mode read failed
  401 and fell back to `enforce` (fail-closed).
- The additive-only scope read failed 401 and was skipped (fail-open).
- The pre-write review list returned 401 (fail-open).
- The post refreshed the token once and succeeded.
- The stale Request-changes dismissal failed 401.

The same shared bucket kept tripping the floor every hour. Throttle rows show
`remaining` 55–59 against floor 200 at 06:41, 07:27, 07:46, 08:46 and later.

## Unproven cause

This SEV does not establish why the shared `default` core bucket stays below
the floor. That bucket merges observations from any `gh` call that records no
credential, so it can reflect a credential other than the reviewer bot's own.
The reviewer's per-token bucket showed 5,308 remaining at 08:19. Whether the
low readings come from a drained credential, from mixed-credential attribution
or from the LAC-2075 budget incident is not proven. This change does not alter
governor policy, budget state, floors or credential attribution.

## Repair (source)

- `src/reviewer-generated-review-delivery.mjs` (new) preserves each validated
  reply before the side calls (`data/reviewer-generated-reviews/`, mode 0600,
  digest-checked). The record is bound to repo, PR, exact head, pass, the
  producing model and bot identity, attempt, prompt stage, verdict-only and the
  SHA-256 of the diff.
- The pre-write delivery phase is bounded: 10 min nominal, load-scaled, capped
  at 20 min, and kept 60 s inside the Gemini process deadline. Phase timing is
  recorded for token refresh, verdict mode, scope review, head grounding and
  scope gates.
- On expiry, and only if no GitHub write has started, the reviewer emits a
  `[reviewer-delivery-stall]` receipt and exits as `[reviewer-stalled]`. That
  is the existing REVIEWSTALL-01 class: claim released, no review, attempt or
  recovery budget charged. The exiting process can no longer publish late.
- `postGitHubReview` marks the write boundary after its throttle and
  pre-write housekeeping, immediately before the GitHub write. Past that
  point the existing post retry, ambiguous-post reconciliation and capture own
  the outcome. A record that reached the write is never redelivered blindly.
- The next same-binding claim replays the preserved reply through the
  unchanged sanitize/reply-contract, verdict-mode, grounding, scope, guard,
  exact-head post and capture path. It posts with zero token usage and the
  original execution and attribution, and marks the record `delivered` so the
  review is posted only once.

Unchanged: verdict and finding gates, exact-head posting, reviewer identity,
CFG keys, governor and budget state, routing, CI and merge authority.

## Regression counts

New suite `test/reviewer-generated-review-delivery.test.mjs`: 12 tests. The
regression drives the real `createRateLimitThrottle` with the witness shape
(core/default, 59 remaining, floor 200) and a sleep that never settles.

- Base `1a5e19f8` plus only the new leaf module: 9 pass / 3 fail. The failures
  are behavioural: no write-boundary hook in `postGitHubReview`, no Gemini
  deadline exposure, no `reviewer.mjs` wiring. Without the module, all 12 fail
  at import.
- Fixed tree: 12 / 12, stable over three runs.

Gates: `npm run lint` 0 errors. `typecheck:contracts` clean.
`demo/research-finding-walkthrough.sh` completed. ARC-10 ratchet: 2,549 of
2,550 lines. SMV: green.

Full `npm test` (bounded runner, 1,140 s): 15,089 tests, 14,955 pass, 6 fail,
120 cancelled. None of the failing files reaches the changed modules through
static or dynamic imports. `dispatch-read-context` (2) and the
`derived-artifacts` cancellation test fail identically on base.
`finalization-queue-routing`, `ama-hammer-background-dispatch` and
`review-pipeline-health` pass in isolation. `hammer-self-rebase` and the SMV
sandbox smoke are known environment/load reds. `reviewer.test.mjs` has 7
environment failures, the same set on base.

## Acceptance boundaries

1. **Source:** this PR merged after a settled adversarial verdict on its
   current head and green CI.
2. **Deployment:** the normal main-catchup deploy of adversarial-review. No
   configuration change. No manual restart is part of this change; reviewer
   processes are one-shot and load the new code at their next spawn.
3. **Loaded:** a reviewer spawned after deployment logs
   `reviewer-delivery-phases` for a normal post.
4. **Organic:** the next real stall shows a `[reviewer-delivery-stall]`
   receipt, a `deferred` record, a released claim with no budget charge, then
   `reviewer-generated-review-redelivery` and exactly one public review at that
   head.

## Live recovery

PR 1700 needs none: the witness delivered its own review at 08:27:25 with the
correct identity and head, and there is no duplicate. The PR has since moved
to head `72f6a8a…`. That head is reviewed through the normal pipeline, and
rescue keeps custody of the live publisher. The witness predates this change,
so it wrote no preserved record. Its Gemini output exists only as the posted
review. Operators must not hand-post preserved reviews. Read-only triage
commands are in
[the Gemini reviewer runbook](../RUNBOOK-antigravity-gemini-reviewer.md#stalled-delivery-after-review-generated-revpoststall-01).

## Follow-up proposals (not built here)

- Governor owner: attribute `execGhJson` and adapter-read observations to the
  pinned credential, so one credential's floor no longer stalls another, and
  decide whether a delivery-ready review may use the urgent reserve. This
  changes governor policy and needs an operator decision.
- The reviewer run record's `lastHeartbeatAt` is never renewed by the reviewer
  process itself, so the run looked alive with spawn-time freshness for an
  hour. The delivery receipt now names the phase. A heartbeat is a separate
  change.
