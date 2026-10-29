# Data Model - Terminal Review Size Actions

**Owner:** watcher reviewer settlement
**Store:** `data/review-size-actions/`
**Source of truth:** `src/reviewer-size-owner.mjs`
**Runtime surface:** `src/reviewer-spawn-settle.mjs`, `src/reviewer-alerts.mjs`

Each terminal size failure creates `<key>.json`, where `key` is the SHA-256
of `JSON.stringify([repo, prNumber, headSha])`. An atomic exclusive write
reserves exactly one PR-update submission before dispatch. `<key>.md` is the
builder's brief, passed through the existing `hq dispatch --pr` path with
branch-push completion and push outcome. The deterministic dispatch key is
`shrink-diff-<key>`; transport failure or a lost acknowledgement retains the
reservation and is reported in the existing oversized-review alert.

| Field | Contract |
|---|---|
| `repo`, `prNumber`, `headSha` | Repository, PR and immutable failed head. |
| `failureClass`, `createdAt` | Terminal size class and settlement timestamp. |
| `nextAction.action`, `actor`, `head` | `shrink-diff`, builder class from the title prefix, and failed head. |
| `nextAction.facts` | `headSha`, total UTF-8 `diffBytes`, `promptBytes`, prompt budget `maxBytes`, chunk cap `maxChunks`, optional timeout `chunkPlan`, and `largestFiles`. Missing legacy diagnostic facts are null/empty. |
| `largestFiles[]` | Up to ten paths sorted by decreasing `diffBytes`: their UTF-8 contribution including diff headers, not blob size. No raw file contents. |
| `dispatch` | Deterministic `dispatchKey`, `reservedAt`, `dispatched`, optional `launchRequestId`, `promptPath` and `error`. An unconfirmed result never proves that a worker was not launched. Alert payloads may also carry `persistenceError` if receipt persistence failed. |

Records are ownership and diagnostic evidence, never a verdict or merge
authorization. Review status stays terminal for that head. A new head gets
ordinary review admission and does not inherit this action. Late old-head
settlement cannot overwrite a replacement session. The existing alert carries
the action and dispatch result after settlement; the reviewer child emits the
head-bound size diagnostic rather than sending an incomplete duplicate alert.
Reservation failure refuses dispatch and preserves the alert with its error;
receipt persistence failure preserves the reserved record and includes the
observed dispatch acknowledgement and storage error in the alert.

There is no automatic retention sweeper. Retain records for open PRs and
archive after closure under the operator's normal audit retention policy.
Never delete a reservation to retry an ambiguous submission without first
reconciling the dispatch identity. No operator state migration, restart, new
configuration or smoke action is required by this change.
