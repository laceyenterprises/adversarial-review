# Pending Background Hammer Dispatches

Store: `data/ama-hammer-background/<sha256(repo#prNumber)>.json`.
Owner: `src/ama-hammer-background-dispatch.mjs`.
Source of truth: `src/ama-hammer-background-dispatch.mjs`, `src/posted-review-row.mjs`.

The queue atomically saves an intent before accepting background work, including
work waiting for a queue slot. Each record contains `repo`, `prNumber`, `headSha`,
`startedAt` (UTC submission time), and a unique `attemptId`. It contains no
credentials, serialized executable work, or cached eligibility decision.
Recovery compares PR numbers numerically so numeric and string callers match
the same record; repository and head comparisons remain exact.

The first posted-review adoption phase after startup reads matching current-head
intents before lane decisions and prioritizes their normal handlers. The lane
admits these handlers immediately; dispatch still rebuilds live state and uses
the existing lease, retry cap, lifetime ceiling, operator holds, and launch dedup.
The in-process queue admits at most one attempt per PR/head. An already launched
hammer remains owned through the closer's normal reconciliation.
Restart priority and its recovery log run only once per process/root; later
adoption phases do not promote ordinary in-flight submissions as restart work.
An intent deferred by the initial phase budget still bypasses lane backoff when
its handler is next considered by normal scheduling.

Settled and cancelled queued entries remove their intent. A normal handler that
reaches an operator or safety hold also retires interrupted intent before
recording operator-blocked cadence, preserving the hold reason and evidence.
Confirmed dispatch and reconciliation of `ama-closer-launch-in-progress` retire
the matching-head intent even when no new queue submission occurs; the closer
lease and launch ledger retain ownership. A running cancellation
retains its record until settlement. Cleanup checks `attemptId` so a late callback
cannot remove a replacement intent. A crash leaves intent for the next process;
there is no expiry that could silently discard interrupted work. Records for a
different head are ignored, and the next submission for that PR replaces them.
When posted-review reconciliation confirms `pr-terminal` (closed or merged), it
removes the PR's intent regardless of head, including abandoned superseded-head
records. The terminal `operator-skip-label` path performs the same cleanup.
Other PRs' intents and the closer's lease/launch records are untouched.
Submission fails if persistence fails; read and cleanup errors are logged.
An unlink failure during queued cancellation does not retain the queue slot or
prevent a newer head from being submitted. Its durable record remains available
for guarded recovery until replacement or successful cleanup.

HAMCLOSEWAIT-02 keeps actual execution start and the existing dispatch timeout
(15-minute fallback) in the process queue. The read-only `get(key)` reports
running/queued evidence or the presence of an unconsumed settled outcome.
Only running, uncancelled work credits the final-round closure wait; queued
submission time in this durable intent is not launch progress. Successful
outcomes retain actual start as `closerProgressAt`; refusals supply no progress.
A process restart loses running evidence and rebuilds work through normal
admission. No durable fields or lifecycle states change.

This store authorizes a prompt retry only. It cannot authorize a launch or merge.
