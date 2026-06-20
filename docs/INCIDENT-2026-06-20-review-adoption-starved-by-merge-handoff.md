# Incident (SEV0) - reviewer adoption starved behind merge-side watcher handoffs

**Date:** 2026-06-20 UTC  
**Severity:** SEV0 (new PR review adoption stalled behind gatekeeper side effects)  
**Status:** live recovered; durable fix proposed in this PR  
**Primary symptom:** new eligible PRs entered `review_status='pending'` but did
not advance to an active reviewer promptly.

## Summary

The adversarial-review watcher was running and successfully discovered new PRs,
but its single `pollOnce` lane queued first-pass reviews behind merge-side work:
AMA closer dispatch, merge-agent fallback dispatch, DAG autowalk retries, and
other post-review maintenance.

The triggering report was `laceyenterprises/agent-os#2172`. The watcher claimed
the PR into `reviews.db` as `pending`, logged `review-queued`, and selected
`codex` as reviewer. It did not start the reviewer because the same tick was
waiting on #2170's terminal remediation / merge-agent dispatch path, which
shells out through HQ worker provisioning.

This was not a reviewer OAuth outage and not a dead LaunchAgent. It was
scheduling starvation inside a live watcher tick.

## Impact

- New PRs could sit in `pending` after being discovered, with no GitHub review
  posted until the merge-side handoff returned or the watcher was bounced.
- Operators saw a misleading half-healthy state: the gate status said
  `review-queued`, but no reviewer process existed for the newly queued PR.
- Merge-side automation could monopolize the watcher at the exact time the
  gatekeeper should be minimizing time-to-first-review for new PRs.

## Evidence

Observed state for #2172 before live recovery:

```text
repo=laceyenterprises/agent-os
pr=2172
review_status=pending
reviewer=codex
review_attempts=0
last_attempted_at=NULL
reviewer_session_uuid=NULL
```

Watcher log evidence:

```text
[watcher] adversarial gate for laceyenterprises/agent-os#2172: pending (review-queued)
[watcher] New PR laceyenterprises/agent-os#2172: "...dag run new..." -> codex
[watcher] adversarial gate for laceyenterprises/agent-os#2170: success (review-settled)
[ama-closer] auto-hammer: dispatching terminal remediation for ineligible PR ...
{"event":"ama_closer.orchestration_mode_noop","route":"hq-dispatch","repo":"laceyenterprises/agent-os","prNumber":2170,...}
[watcher] AMA closer recovery fallback for laceyenterprises/agent-os#2170: dispatch-failed; dispatching merge-agent ...
{"event":"merge_agent.orchestration_mode_noop","route":"hq-dispatch","repo":"laceyenterprises/agent-os","prNumber":2170,...}
```

Process evidence showed watcher pid `91318` waiting on `cwp_dispatch.cli` for
`AMA-PR-2170` / `PR-2170`, while orphaned or long-running
`hq-worker-provision.sh` children remained in the watcher process group. No
`reviewer.mjs` process existed for #2172 at that point.

After an operator recovery bounce, #2172 advanced normally:

```text
[reviewer:2172] [reviewer] Starting review: laceyenterprises/agent-os#2172 model=codex
[reviewer] Review posted to laceyenterprises/agent-os#2172
```

GitHub showed a `lacey-codex-reviewer` review posted at
`2026-06-20T04:18:57Z`.

## Why the earlier fix did not prevent this

The previous poll watchdog work prevents a completely hung `pollOnce` promise
from being invisible forever. This incident is narrower and nastier: the poll
was making legitimate progress, but it performed lower-priority side effects
before draining the queued reviewer dispatches.

That means the watchdog could still allow a long "healthy" tick while new PRs
sat in `review-queued`. The failure was scheduling priority, not process liveness.

## Root cause

`watcher.mjs` accumulated first-pass reviewer candidates in
`reviewerDispatchCandidates`, but drained that queue only after:

- posted-review row handling, which can launch AMA closer or merge-agent workers;
- proactive merge-agent scans;
- lifecycle sync and DAG autowalk maintenance;
- retry/comment cleanup work.

Those lower-priority tasks can shell out to `hq`, `gh`, or DAG tooling. If any
of them is slow or wedged, newly discovered PRs remain pending even though the
watcher already knows they need review.

## Live recovery

The live recovery was intentionally minimal:

1. Verified the active watcher LaunchAgent was
   `ai.laceyenterprises.adversarial-watcher.airlock`.
2. Verified #2172 was open, non-draft, green, and present in `reviews.db` as
   `pending`.
3. Identified the blocking #2170 `cwp_dispatch.cli` / `hq-worker-provision.sh`
   child path.
4. Used the documented merge-agent cancellation path for #2170.
5. Restarted the watcher LaunchAgent after #2170 had merged, clearing the stale
   in-flight poll.
6. Verified #2172 received an actual Codex reviewer pass.

## Durable fix

The watcher must treat reviewer adoption as the first-class gatekeeper duty:

- discover and enqueue review candidates;
- drain reviewer dispatch candidates before posted-review merge handoffs;
- defer posted-review handlers until after reviewer dispatch;
- defer merge-agent proactive scans and post-merge maintenance until after
  review adoption.

This preserves the existing merge/remediation behavior while ensuring a slow
merge-side child cannot starve first-pass reviews that have already been queued.

## Follow-ups

- Add richer health output for `pending` rows with no
  `last_attempted_at`/`reviewer_session_uuid` when the watcher is alive but has
  not advanced them within a small SLA.
- Continue hardening HQ provision so shell children fail fast rather than
  waiting on long watchdogs.
- Keep the gatekeeper surface out of admin-merge except for recursive recovery;
  this file accompanies a normal adversarial-review PR.
