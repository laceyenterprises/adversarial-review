# Watcher poll starvation recovery

WATCHERSTARVE-01 distinguishes a slow, productive poll from a frozen poll.
The idle stall watchdog still handles a watcher that stops starting polls.
The poll deadline still bounds an individual poll and preserves reviewer
runtime sessions when it exits for supervisor recovery.

WATCHERSTARVE-02 makes the in-flight starvation threshold independent of the
poll deadline. Without an override, the threshold is the greater of 15 minutes
and three poll intervals. A positive `ADVERSARIAL_WATCHER_POLL_STARVATION_MS`
sets the threshold exactly, including values below the poll deadline.

Completed work resets the no-progress window, so a slow, productive poll does
not need a threshold above its deadline. The workload-aware deadline can span
hours: using it as a floor would delay hang detection for hours as well. For
example, a 60,300-second poll deadline leaves the default threshold at 900
seconds for a five-minute poll interval, or at 2700 seconds with a 2,700,000 ms
override. The poll deadline computation is unchanged.

The startup log prints the actual poll deadline and effective starvation
threshold. Both values are logged again when workload changes the deadline
between polls. Deadline changes do not raise or lower the starvation threshold.

Only completed work advances progress: completed poll phases, subject fetches
and processing, posted-review and maintenance handlers, plus the existing
review/spawn-decision markers. These markers reset the entire no-progress
window. Timer ticks, handler entry and heartbeat persistence do not count.
After a full threshold without progress, the configured consecutive checks
(default three) trigger one reviewer-preserving exit with code 75.

WATCHERHB-01 also persists advancing poll progress to the canonical heartbeat
when at least 60 seconds have elapsed since its last write attempt. Ordinary
heartbeat writes reset that interval; failed attempts are throttled too. Each
`poll-progress` event refreshes `updated_at` and `last_poll_progress_at` through
the same ownership guard and atomic writer. `last_poll_at` continues to record
the poll start. There is no periodic refresh without completed work, and the
in-process watchdog thresholds and poll deadline are unchanged.
Debounced review writes capture current heartbeat state when they run, preserving
progress counters and timestamps advanced after the review was queued. Review
metadata is retained, and `last_review_at` still records the review marker time.

Restart history and the loop-page debounce are persisted in the existing
canonical heartbeat, using its ownership guard and atomic writer. A second
watchdog restart within one hour emits
`adversarial_review.poll_starvation_restart_loop` with both poll durations.
Further restarts in the same episode continue recovery without repeating the
page once it has been durably queued. A quiet hour rearms paging. Failed
page enqueue stays retryable across respawn; reporting failures are logged and
do not prevent recovery. This guard records only starvation-triggered restarts;
ordinary deployments and idle-stall/deadline exits do not count.

After deployment, the SRE session verifies:

1. The watcher restarted after deployment and its startup line shows both the
   poll deadline and `poll-starvation respawn` at the requested value (2700 s
   while the operator override is set), rather than deadline plus 60 s.
2. For six hours, progressing polls emit no `FATAL: watcher poll starved`, and
   the launchd run count stays flat.
3. While pull requests are mergeable, the review lane merges at least once per
   hour.
4. During a poll longer than 40 minutes that continues making progress, the
   heartbeat file's `updated_at` stays under about two minutes old.
5. With companion WATCHDOGFRESH-01 deployed, launchd `runs` stays flat over
   six hours. That companion makes external liveness use the newest of
   `last_poll_at`, `updated_at` and `last_poll_progress_at`.

The offline regression tests use fake clocks, synthetic identities, injected
heartbeat storage and injected alert/exit functions. They do not read or change
live host state.
