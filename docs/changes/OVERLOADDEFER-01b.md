# OVERLOADDEFER-01b

The watcher owns launch-less rescue overload receipts on startup and a
30-second timer. It scans up to 100 directory entries asynchronously per tick
and drains each window's due queue before advancing. One bounded child at a
time submits only repository and PR identity to the companion
`hq merge-agent rescue --apply --retry-overload-only` entrypoint, which must
re-read head, review, holds, writers and original-key custody. Legacy exhausted
receipts with null retry times remain eligible. Deploy the companion first.

Live AMA enablement/execution switches gate every tick. Failed children and
successful children leaving unchanged retry state back off per PR from 30 seconds
to 30 minutes in memory; restart resets that backoff. Queued receipts are
revalidated before execution. Broken directory handles close and reopen on the
next scan. Watcher SIGTERM/SIGINT immediately shuts down the background queue and aborts the active rescue process
group alongside reviewer cleanup, with forced settlement after kill. All process exits synchronously abort rescue. Attempt-history eviction tracks latest attempt.

Helper exhaustion emits one PR/head page, archives `lastOverloadDeferral` and
releases the overload hold to ordinary capped closer selection. Later same-job overloads within 30 minutes
inherit the archived exhausted count and immediately release through the same
page deduplication path, without another multi-cycle hold or refund. Ordinary
attempt/lifetime/target caps, leases, head matching, attestation, strict mode
and authoritative terminal-state reconciliation remain in force.

After deployment and the watcher/follow-up restart, retain deployed revisions
and process start times. Observe an organic receipt advancing or launching
within one directory rotation including queued due receipts, bounded child
execution and applicable per-PR backoff. A rotation includes one timer turn per
queued child, rather than only directory scanning. Confirm closer or released
ownership without manual pumping. Source fixtures do not establish deployment
acceptance; this change performs no live repair or restart.

The replacement preserves the prior patch and fixture import repairs. The
squash onto current main required no textual conflict resolutions. Review
repairs add queued-debt retention, no-op backoff, shutdown cleanup, cursor
recovery, immediate re-exhaustion and aligned acceptance wording. The generated
catalog is left to main automation; its source fragment carries the contract.
This fragment follows the ticket's requested `changes/` location.

Validation: 522 focused tests passed across the retry driver, overload deferral,
closer retry cap, GitHub API, watcher fast merge, timeout handoff, claim loop and
state-machine sandbox files. Files ran serially under netguard with individual
600-second process-group bounds. ESLint reported zero errors; contract
typechecking, data-model validation (93 entries), the offline research
byte-equivalence demo and whitespace checks passed. The plain-shell CI mirror
passed its two fast checks and deferred the full suite to CI. No full worker-pool
suite ran.

## HAM final findings

Shutdown starts queue cancellation and rescue abort before reviewer cleanup, with bounded pipe settlement and exit-path abort. Removed receipts count as progress. Receipt file age limits stale retries to 24 hours across watcher restarts. Exhaustion inheritance is limited to the same job and 30 minutes, retaining ordinary lifetime caps. Original state contract text and the canonical note path are restored.
