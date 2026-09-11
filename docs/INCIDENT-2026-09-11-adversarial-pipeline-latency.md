# INCIDENT 2026-09-11 - adversarial pipeline latency and pre-LRQ hammer dispatch stalls

**Severity:** SEV2
**Status:** Open
**Opened:** 2026-09-11 10:16 America/Los_Angeles
**Tracking issue:** https://github.com/laceyenterprises/adversarial-review/issues/1042
**Primary surfaces:** adversarial watcher, follow-up daemon, AMA/hammer dispatch,
HQ worker boot/provisioning

## Summary

The adversarial review pipeline is publishing reviews again, but the
review-to-merge path is still too slow and too easy to strand in partially
observable states. Terminal PRs can remain open after clean current-head review
because the watcher spends its posted-review budget inside AMA/hammer dispatch,
and that dispatch can stall before an LRQ or dispatch id is persisted.

This is a latency incident, not just a hammer incident. The slow surfaces span
reviewer admission, posted-review processing, follow-up carrier settlement, AMA
coexistence, HQ dispatch admission, worker provisioning, token/auth setup,
adapter spawn, process registration, first heartbeat, and first worker output.

## Impact

- Automatic merge closure is not keeping up with the PR backlog.
- Operators are manually merging or manually rearming reviews to kick progress.
- A terminal PR can hold an AMA closer lease while its dispatch record remains
  `state=dispatching` with both `dispatchId` and `launchRequestId` null.
- The watcher can exceed its posted-review handler deadline while waiting for
  a hammer dispatch that has not yet become traceable through HQ.
- Review posting success can hide downstream merge starvation, so the pipeline
  looks healthier than it is.

## Evidence captured during the incident

- Pipeline health at `2026-09-11T10:12:32Z`: first-pass queue depth 5,
  follow-up pending 0, follow-up in-progress 0, follow-up failed 0, stopped 85.
  Reviewer posts were succeeding, but merge progress was still lagging.
- `laceyenterprises/agent-os#6595` had a clean current-head review posted at
  `2026-09-11T10:01:47Z` and green checks, but its AMA closer dispatch record
  was still `state=dispatching` after `2026-09-11T10:10:54Z` with
  `dispatchId=null` and `launchRequestId=null`.
- The watcher logged a posted-review deadline overrun on `agent-os#6595`:
  `resolveMergeAgentCoexistence deadline_ms=87500`, in-flight operation
  `ama-hammer-dispatch`, in-flight elapsed about 60 seconds.
- The process table showed nested `hq-worker-provision.sh` processes for
  `hammer-ama-pr-6595-87f17378913b` under watcher-spawned `cwp_dispatch.cli`
  before any LRQ was persisted.
- `laceyenterprises/agent-os#6610` posted-review processing spent 5.3s and
  17.3s in `fetchMergeAgentCandidate`, then 15.5s and 5.5s in
  `resolveMergeAgentCoexistence`.
- `laceyenterprises/agent-os#6599` received a clean review at
  `2026-09-11T10:07:34Z`; its settled-clean follow-up carrier was created at
  `2026-09-11T10:08:36Z` and stopped by the follow-up daemon at
  `2026-09-11T10:11:05Z`. That path worked, but it added avoidable closure
  latency under backlog pressure.
- `laceyenterprises/adversarial-review#1041` remained visible as a merge-stall
  candidate from a stale stopped job even after its current head was reset to
  pending review, which suggests health/stall detection can over-report stale
  stopped jobs.
- `laceyenterprises/adversarial-review#1037` had a recovered posted review
  artifact for a current-head request-changes review, but the recovery path did
  not create the durable follow-up remediation job. PR #1041 adds that recovery
  handoff for future occurrences.
- Launchpad seven-day health showed 256 failed launches and 708M failed-launch
  tokens. Recurring classes included `spawn_never_registered`,
  `adapter_spawn_timeout`, `adapter_boot_crash`, `hcp_token_mint_failed`, and
  killed-worker classes.

## Current hypotheses

1. The AMA/hammer path performs too much synchronous work inside the watcher
   posted-review handler before persisting an LRQ or dispatch id.
2. `hq-worker-provision.sh` can spend significant time in nested provisioning
   or preflight phases with no structured boot span tying that time back to the
   PR, worker class, dispatch id, and eventual worker process.
3. Clean review settlement relies on a follow-up carrier job and a later daemon
   consume tick. The path is recoverable, but it adds closure latency and creates
   extra moving parts when the queue is already under pressure.
4. Health surfaces distinguish reviewer-post success from merge/closure
   success, but still lack enough pre-LRQ instrumentation to prove where boot
   latency is spent.

## Immediate recovery work

- Finish current-head review and merge recovery for
  `laceyenterprises/adversarial-review#1041` and `laceyenterprises/agent-os#6610`.
- Recover `laceyenterprises/adversarial-review#1037` through a supported path so
  its request-changes review produces a follow-up remediation job.
- Clear or terminalize the `agent-os#6595` pre-LRQ AMA/hammer dispatch stall.
- Ensure terminal clean/comment-only PRs either merge promptly or emit an
  actionable blocked reason with a persisted dispatch id or LRQ id.

## Engineering follow-up

- Instrument every worker boot path, not only hammer:
  HQ dispatch admission, worker provisioning, repo/worktree prep,
  submodule/dependency hydration, HCP/token mint, adapter spawn, process
  registration, first heartbeat, first worker output, and terminal settlement.
- Each latency span should include worker class, task kind, repo, PR, worker id,
  dispatch id, LRQ id when available, phase, elapsed milliseconds, result, and
  failure class.
- Make pre-LRQ dispatch stalls observable and bounded: an AMA/hammer dispatch
  must not remain `dispatching` with no LRQ or dispatch id for more than 60
  seconds without a terminal retryable/failed state and a clear next action.
- Reduce or decouple slow posted-review work from watcher tick deadlines; target
  p95 posted-review handler time under 30 seconds when no external merge
  dispatch is required.
- Reduce clean-review-to-closure latency; target first closure attempt within
  120 seconds of a current-head clean review.
- Use the autowalker and active build packs to measure launch p50/p95 and boot
  success rate across `codex`, `claude-code`, `gemini-reviewer`, `remediator`,
  `merge-agent`, and `hammer`.

## Exit criteria

- Worker boot success rate is at least 80% across the exercised worker classes.
- Reviewer post success is 100% for current-head reviews during the validation
  window.
- Hammer/AMA closes at least 90% of eligible terminal tickets without manual
  intervention.
- Pre-LRQ hammer/AMA dispatch stalls are visible in structured telemetry and
  self-terminalize or retry under policy.

## Related work

- https://github.com/laceyenterprises/adversarial-review/pull/1041
- https://github.com/laceyenterprises/adversarial-review/pull/1037
- https://github.com/laceyenterprises/agent-os/pull/6595
- https://github.com/laceyenterprises/agent-os/pull/6599
- https://github.com/laceyenterprises/agent-os/pull/6610

## Linear mirror

The operator-facing Linear issue should be created when the Linear connection is
healthy again. During this incident the Linear connector returned
`oauth_token_invalid_grant`, so GitHub issue #1042 is the live incident record.
