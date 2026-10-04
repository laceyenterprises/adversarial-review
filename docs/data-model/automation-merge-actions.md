# Data Model - Automation Merge Actions

**Owner:** AMA merge execution evidence (OPSEV1-03)
**Store:** `$HQ_ROOT/dispatch/audit/automation-merge-actions/`
**Source of truth:** `src/ama/merge-action-receipt.mjs`
**Runtime surface:** `bin/merge-action-receipt.mjs`, `src/github-adapter-client.mjs`,
`src/ama/daemon-merge.mjs`, `src/fast-merge-processing.mjs`

## Purpose and identity

Each JSON file records a merge execution or refusal for an exact
`(repo, prNumber, headSha)`. These append-only receipts supply execution evidence
for autonomy scoring. They do not grant merge authority or replace the
[AMA closure audit](ama-audit.md).

Filenames are `<owner>-<repo>-pr-<number>-<headSha>-<uuid>.json`. Repeated
calls append distinct files; consumers must not infer a unique attempt from the
PR/head tuple alone. There is no in-place update or deletion by the writer.

| Field | Shape | Contract |
|---|---|---|
| `receiptProtocol` | string | Always `OPSEV1-03`. |
| `repo` | string | `owner/repo`; each component contains word characters, dots or hyphens. |
| `prNumber` | positive integer | GitHub PR number. |
| `headSha` | string | Exact 40-character lowercase hexadecimal PR head. |
| `producerClass` | string | `ama-daemon` or `closer-hammer`. |
| `actor` | string | Derived from producer: `AMA` or `hammer`, respectively. |
| `action` | string | `gh pr merge` (default) or `api merge`. |
| `merged` | boolean | Whether this producer executed a verified merge. |
| `reason` | string or null | Required and non-empty for refusal; defaults to null for success. |
| `executedAt` | timestamp string | Parseable date; defaults to the writer's current ISO timestamp. |

## Publication and failure behavior

The writer requires the current username to match `.hq/config.json`'s
`ownerUser` and the HQ root to belong to that user's UID. Audit directories must
be real directories owned by that UID and not writable by group or others.
New directories use mode `0750`. Receipt files use mode `0640`, the owner's
UID and the HQ root's GID.

Publication creates an exclusive temporary file, sets ownership and permissions,
writes and fsyncs it, closes its descriptor, then hard-links it to a unique
target and fsyncs the directory. A `finally` block closes the file even when
permissions, ownership, writing or fsync fails; another removes the temporary
name. A failure after linking may leave the published receipt in place.

Success requires caller-side live exact-head confirmation and evidence of its
own merge execution; idempotent/already-merged responses must not claim a new
execution. The hammer CLI additionally requires a merge timestamp within two
minutes of its execution timestamp. The hammer CLI and adapter's direct
`gh pr view` confirmation use `execGhWithRetry`: at most three transient-read
attempts, 500/1000ms backoff, and a 15-second subprocess timeout per attempt.
Timeouts, EIO, transport errors, rate limits and HTTP 5xx are retryable.
Permanent permission failures are not retried; rejected authentication uses the
helper's separate, single token-refresh attempt. Malformed JSON or an unverified
head produces no success receipt.

Daemon callers use `recordMergeActionBestEffort`, which logs receipt-write
failures and preserves the merge result. The adapter likewise warns after
verification exhaustion without reissuing the merge. The CLI exits non-zero on
verification or publication failure except for the isolated-worker handoff below.
Receipt failure never changes the existing authority flags or eligibility gates.

## Isolated-worker request handoff

When the CLI is not running as `ownerUser`, it can instead append a request to
`$HQ_ROOT/workers/<HQ_WORKER_ID>/merge-action-requests/<uuid>.json`, provided a
valid worker ID and `HQ_LAUNCH_REQUEST_ID` (or `LAUNCH_REQUEST_ID`) are present.
The request has the same record fields plus `launchRequestId`. Its directory
uses mode `0750`, its file uses `0640`, and the file is owned by the worker UID
with the HQ root's GID. Only HQ-owner teardown publishes these requests as
trusted receipts. That consumer belongs to the Agent OS superproject; this
repository owns the writer and request format.
