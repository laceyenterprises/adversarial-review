# Pending Background Hammer Dispatches

Store: `data/ama-hammer-background/<sha256(repo#prNumber)>.json`.
Owner: `src/ama-hammer-background-dispatch.mjs`.

The queue atomically saves an intent before accepting background work, including
work waiting for a queue slot. Each record contains `repo`, `prNumber`, `headSha`,
`startedAt` (UTC submission time), and a unique `attemptId`. It contains no
credentials, serialized executable work, or cached eligibility decision.

The first posted-review adoption phase after startup reads matching current-head
intents before lane decisions and prioritizes their normal handlers. The lane
admits these handlers immediately; dispatch still rebuilds live state and uses
the existing lease, retry cap, lifetime ceiling, operator holds, and launch dedup.
The in-process queue admits at most one attempt per PR/head. An already launched
hammer remains owned through the closer's normal reconciliation.

Settled and cancelled queued entries remove their intent. A running cancellation
retains its record until settlement. Cleanup checks `attemptId` so a late callback
cannot remove a replacement intent. A crash leaves intent for the next process;
there is no expiry that could silently discard interrupted work. Records for a
different head are ignored, and the next submission for that PR replaces them.
Submission fails if persistence fails; read and cleanup errors are logged.

This store authorizes a prompt retry only. It cannot authorize a launch or merge.
