# Hammer merge logic

The world-fact stop rule applies throughout closure: correct closer-owned helper
or environment mistakes once, then defer exhausted harness faults. An ended,
charged launch is refunded and owned by the watcher with backoff
(INCONCLUSIVERETRY-01b): it never parks, and from attempt N it is surfaced once
without spending PR adjudication budget. Canonical local runner
setup failures leave the exact-head GitHub required gate authoritative and claim
no local pass. Unsupported pnpm workflows use this fallback. Missing/floating
pnpm pins and started script failures remain real failures; exhausted npm startup
retries use the existing non-counted `validation-environment-failed` closer
recovery. Existing lifecycle values and smoke promises are unchanged.
Review, head, CI, policy and GitHub facts retain stop authority;
strict mode, attestation, reversal checks, leases and merge predicates remain
mandatory. See the [closure runbook](RUNBOOK-ama-closure.md).

Daemon and closer merge requests share FIFO arrival order. A closer releasing
without merge retains its PR's original arrival across heads for restoration
before `nextEligibleAt` plus one configured watcher poll interval (unscaled).
An absent closer returning later joins at the tail; a live registered waiter
keeps its order through its invocation deadline. Exponential backoff lets ready
waiters proceed. Daemon releases preserve closer memory and its fixed expiry
while their reservations re-enter at the tail. Status/list separates FIFO
`ageSeconds` from `invocationAgeSeconds`, measured from `registeredAt` when present.
Consecutive chargeable failures park the head with `repeated-no-merge-release`
after the existing attempt cap.
Planned CI-wait yields and retryable aborts retain backoff but reset consecutive
failure counting; non-permanent daemon failures yield too. Yields and retryable aborts refund the
provisional gate charge atomically with release identity. Only daemon
reservations requeue; the next CLI invocation registers a fresh waiter with its
remembered arrival and a fresh invocation deadline. Parking and merged/closed
releases clear remembered arrivals across heads. Focused offline merge-lease
fixtures verify bounded retention, daemon preservation, mixed-role backoff, head
changes, status ages and terminal cleanup. Both parking caps use the existing audit, closing-status and page path.
Only confirmed dead same-host watcher identities permit early reservation pruning. Closers release
before the first remote-CI wait, including read retries and UNKNOWN sampling, then
reacquire and refresh the exact-head gate. HAMRESUMEOWED-01 retains CLEAN
heads and known non-strict MERGEABLE BEHIND heads with their exact-head CI,
including overlapping-file base advances. GitHub conflicts or BEHIND blocked
by strict/unknown protection require rebase. LEASEFAIR-02 handles a
required rebase in the same run, holds the reacquired
lease through one CI wait capped by `HAM_CI_RETRY_WAIT_SECONDS` (default/minimum 120 wall-clock seconds) on the new head, then rebuilds its audit and
predicate before merge. Both CI waits share one absolute deadline, set before
the first wait from the once-scaled nominal bound; rebase time, sleeps and gate
reads consume the remaining budget. Expired reacquisition or base probing cannot
start a retry source mutation. Conflict, red CI and expiry release with their
actual reasons. Deferred daemon reservations retain their arrival before the retry
acquires. Contention notices report the queue position; the existing
bounded-wait page is a lease wait, not a safety hold. The lifecycle states are
unchanged; the clean smoke verifies FIFO service without preemption. Additional offline regressions are in `hammer-self-rebase`, `ama-merge-lease`,
`ama-daemon-merge`, `watcher-daemon-clean-merge` and `leasepark-ci-wait` tests.
HAMLEASE-01 progress reports occur at least 25 seconds apart, with a maximum
gap of 40 seconds (25 seconds plus the fixed 15-second polling ceiling, excluding
synchronous I/O); the waiter data-model documents the polling contract.

LEASEFAIR-03 gives closers a progress-aware lease wait: a 900-second nominal
stall bound and six-hour nominal ceiling, each load-scaled once. Service advances
reset the stall timer; all roles retain FIFO order. Exact-head green exhaustion gets
two in-run retries and then next-pass recovery without failure charges. The
per-base JSONL history retains 4096 lease events; the clean smoke verifies grants
and releases for both roles, including the retry CI hold. See the
[history contract](data-model/merge-lease-history.md).
LEASEFAIR-04 keeps daemon reservations through twice the configured watcher poll
interval, scaled once for host load and capped below the timer limit. Ineligible,
moved or merged heads release their reservation immediately. Confirmed dead
same-host watchers lose their reservations before queue selection. Holder release
wakes the first daemon PR at its reserved head through the existing per-head cap.
The clean offline smoke verifies service at 299 seconds and an exact-head release
wake; no deployment configuration or migration is needed.
CLI polling doubles from 250ms to a fixed 15-second ceiling, independent of
host load. Both release paths wake sleeping CLI waiters through a directory
watch of the matching holder file; the existing daemon wake is unchanged.
Ambiguous directory events wake only on a holder metadata change, preserving
macOS release notifications without spinning on queue writes.
Watch failures fall back to polling. Focused merge-lease CLI tests cover prompt
release wakeup, FIFO ordering, fixed polling and watch failures.
Status/list includes arrival time, role and position; history records re-entry
and parking with the release reason. Synthetic merge-lease and daemon-merge
regressions cover starvation, backoff, parking, drafts and bounded polling.
See the [waiter contract](data-model/merge-lease-waiters.md).
LAC-2098 separates the acquiring CLI's PID/lifetime from its parent holder PID.
Each invocation owns a fresh waiter ID and bounded cleanup on timeout, failure
and SIGINT/SIGTERM/SIGHUP. Only confirmed same-host acquisition absence allows
early pruning; live/reused/unknown and foreign-host requests retain their existing
deadlines. The clean smoke verifies dead-child/live-parent empty-lane progress;
`cli-waiter-lifecycle` fixtures cover real fixture-child signals, immediate poll
timer cancellation and fixed 250ms cleanup backoff under lock contention.
Runtime acceptance requires separate read-only observation after deployment; see
the [RCA](RCA-LAC-2098-cli-waiter-lifetime-2026-10-24.md) and
[waiter contract](data-model/merge-lease-waiters.md).

LAC-2087 extends cleanup to posted-review candidate exits, including operator
skip before any closure attempt. The clean smoke proves abandoned daemon waiter
removal with a live watcher PID, preservation of other FIFO requests and next
closer acquisition. The concrete coexistence operation owns cleanup after a soft
caller deadline even on terminal/stacked-base exits before closure dispatch or
rejection; eventual eligible contention retains its reservation.
An in-process guard excludes overlapping passes for the same review root/repo/PR,
including changed heads, until the handler and concrete operation both settle.
The handler rejects malformed owner/repo identifiers and nonpositive or unsafe PR
numbers before acquiring that guard; decimal PR number strings remain accepted.
Other PRs continue; a later poll resumes after settlement. Late failures are
logged and observed by the step's existing promise race. Cleanup uses the stored
review base when candidate base metadata is missing. The clean smoke verifies
these boundaries without catching the detached operation in the test harness.
`daemon-waiter-lifecycle` fixtures also exercise head changes,
terminal candidates, an unchanged active holder fence and concrete active
closure ownership across a soft caller deadline. No lifecycle states
or merge gates change. Lifecycle polling also reconciles persisted daemon
reservations independently of open review rows: terminal live evidence must
match repo/PR/full head/base, and the entire waiter must still match its
pre-read snapshot under the shared mutation lock. Concurrent refreshes and
unverified or live PRs survive for later verification. The focused
`terminal-daemon-waiters` fixtures cover external merges, concurrent refresh,
live service PID, surviving FIFO order and holder preservation. Existing clean
smoke promises remain unchanged. Runtime recovery requires separate read-only observations
after normal deployment; see the [lease runbook](RUNBOOK-ama-closure.md#leasefair-01-fair-merge-lease-service).

When the hammer closes a PR,
`templates/hammer-prompt.md` directs one linear flow. The verify-head,
publish, and merge procedures live in `bin/hammer-*.sh` and are rendered by
`bin/hammer-procedure.mjs` into the same persistent shell so the verified
head and merge lease survive between phases. Formal operator requests for
changes survive pushes and rebases until dismissed or followed by a later
approval from the same issuer. HAM reuse checks this proof before the merge
lease and again before transport; review holds use a five-minute recovery
backoff. Review-change and operator-veto audit deferrals do not earn an automatic
retry refund. A proven pre-transport writer timeout keeps its charge and can
re-enter bounded closure admission. An unresolved writer keeps its head and
base fenced for reconciliation. The daemon checks that fence before taking
the lease and again while holding it.
See the [standing-review contract](RUNBOOK-ama-closure.md#standing-operator-reviews-and-the-merge-writer-lac-2305).
The wrapper prints each phase's bounded diagnostic tail, status, outcome, and
lease state. A final-gate conflict with green or pending CI and no other blocker
yields the lease for a bounded replay through local validation and exact-head
publication. Conflict markers return `needs-rebase-repair` for local resolution
or same-head recovery.

HAMSELFREBASE-01 keeps a successful server-side rebase in this flow: verify-head
fetches the exact resulting SHA, detaches the scratch checkout and synchronizes
initialized submodules before changed-surface revalidation. Publish and recovered
attestations compare the live head with `HAM_PRODUCED_HEAD`; required checks and
merge remain bound to that head under the merge lease. LEASEFAIR-01 releases
before the first remote-CI wait and reacquires before merging; LEASEFAIR-02
retains that lease through one retry CI wait, capped by `HAM_CI_RETRY_WAIT_SECONDS` (default/minimum 120 wall-clock seconds), if the base policy requires it. Foreign pushes still
stop with `head-changed`. Existing lifecycle states are unchanged.

Old-head update-branch acknowledgements now poll without repeating the mutation.
A later head needs an exact ordered full-tree replay onto the pre-mutation base
before a pushed provenance edge is published. It still needs fresh exact-head
checks, audit/range proof and the full predicate. The clean offline smoke proves
two queued validated PRs drain across unrelated advances, preserving source heads
and leaving no holder/waiters. Focused `rebase-result` and `hammer-self-rebase`
fixtures cover invalid candidates and bounded failure cleanup. See the
[LAC-2097 RCA and deployment acceptance](postmortems/LAC-2097-validated-closer-convergence.md) and the
[2026-10-27 recurrence RCA](postmortems/LAC-2097-closer-convergence-recurrence.md).
Outside-lease targeted validation records the exact tested head/base pair before
verify-head re-entry; overlapping base drift or another head still requires validation.
Its yield reason is `local-validation`, and captured audit bases require ancestry
proof. Protected classic-checks-disabled 404s remain strict because rulesets may
apply. The default 120-second retry ceiling favors lane fairness over slow-CI in-run
convergence; set `HAM_CI_RETRY_WAIT_SECONDS` to a measured allowance of at least
120 seconds for slower CI (the original absolute deadline still applies). Invalid
values use 120. Pending gate charges remain, and pushed-only provenance does not
promise certified operator-free redispatch. These limits and the focused offline
fixtures are recorded in the recurrence RCA; no lifecycle states or smoke
promises change.

The first verification uses the same retention policy. An inaccessible protection
endpoint can resolve non-strict only through authoritative unprotected branch
metadata. Copied scripts include a diagnostic source SHA-256. Run optional local
validation outside the lease, then re-enter verify-head before audit publication.

1. **Acquire the merge lease** for `(repo, base, PR)` — no merge happens without it.
2. **Remediate all adversarial findings** the final review raised — blocking and
   non-blocking.
3. **Rebase onto the base branch** for a GitHub conflict or strict BEHIND, and confirm the rebased
   head is content-equivalent to the reviewed head (or re-validate it).
4. **Push the validated head.**
5. **Release while waiting for GitHub required checks**, then reacquire and
   confirm the exact green head satisfies the GitHub conflict/strict-BEHIND policy.
6. **`gh pr merge --match-head-commit <validated head>`** while holding the lease.
7. **Append the terminal audit and release the lease.**

HAMATTESTRETRY-01 keeps audit delivery failures on the existing deferred retry
path. Publication retries transient GitHub errors five times under the lease,
then retains a validated base/head edge in AMA audit state. A later hammer can
post that edge before its provenance check only when the current head, last
reviewed base and authenticated App identity match. Different inputs retain the
exact-head review fallback. Failed recovery delivery marks the lease release as a
retryable `audit-comment-unavailable` abort, preserving the pending edge for retry.
Existing lifecycle states and smoke promises remain unchanged; offline recovery
fixtures live in `test/hammer-attestation-retry.test.mjs`.

The hammer does **not** run a local test battery or a pre-push CI mirror as a
merge gate — GitHub required checks are the sole CI authority. This removes the
original merge-agent state machine's fatal flaw of running heavy local suites
inline before every merge.

---
