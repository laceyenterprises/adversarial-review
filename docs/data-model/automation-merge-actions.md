# Data Model - Automation Merge Actions

**Owner:** AMA merge execution evidence (OPSEV1-03)
**Store:** `$HQ_ROOT/dispatch/audit/automation-merge-actions/`
**Source of truth:** `src/ama/merge-action-receipt.mjs`
**Runtime surface:** `bin/merge-action-receipt.mjs`, `src/github-adapter-client.mjs`,
`src/ama/daemon-merge.mjs`, `src/fast-merge-processing.mjs`, `bin/hammer-merge.sh`

## Purpose and identity

Each JSON file records a merge execution or refusal for an exact
`(repo, prNumber, headSha)`. These append-only receipts supply execution evidence
for autonomy scoring. They do not grant merge authority or replace the
[AMA closure audit](ama-audit.md).

Filenames are `<owner>-<repo>-pr-<number>-<headSha>-<uuid>.json`. Repeated
calls append distinct files; consumers must not infer a unique attempt from the
PR/head tuple alone. There is no in-place update or deletion by the writer.

An optional `deliveryKey` (word characters, `:`, `.` or `-`, at most 200) names
exactly one receipt: the filename suffix becomes `key-<first 32 hex of
sha256(deliveryKey)>` and the record carries `deliveryKey`. A repeated write
with the identical record is a replay that returns the existing file; a
different record under the same key refuses. The v2 queue outbox (MGQ-06) uses
this so a lost outbox receipt or restart cannot double automation accounting.

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
| `deliveryKey` | string (optional) | Present only for stable-key outbox deliveries; see above. |
| `derivedChanges` | array (optional) | MIGRENUMBERDERIVED-01 proof of `mechanical-migration-renumber`. At most eight entries, each containing `classification`, `path`, `destination`, `registryPath`, `primaryBlob`, `blob`, `primaryRegistryBlob`, `registryBlob`, `primaryHead`, `headSha`, `mergeBase`. MIGRENUMBERDERIVED-02 adds `chain` observations (`headSha`, `path`, `blob`) from protected author to candidate head. Alembic proofs also bind `modulePath`, `moduleDestination`, `primaryModuleBlob` and `moduleBlob`. MIGRENUMBERDERIVED-03 author-SQL proofs instead carry `moduleOrigin: author-sql`, `sqlPath`, `sqlDestination`, `primarySqlBlob`, `sqlBlob`, `moduleDestination`, `moduleBlob`, `moduleIdentity` (normalized module blob hash), and `snapshotMergeBase`; `primaryRegistryBlob` is the snapshot-base registry, with no author-owned `modulePath` or `primaryModuleBlob`. All blobs/heads are Git SHAs and each `headSha` must equal the receipt head. Relative paths exclude traversal. |

Chains normally increase strictly. A chain with mechanical filename resets
carries `rebased: true`; every observed slot must remain at or above the author's
original slot. The evaluator requires transient `migrationRenumberAncestry:
{ primaryHead, headSha, status: diverged }` from an immutable compare bound to
both heads before admitting that non-monotonic chain (for example
309→310→311→309→312). The ancestry evidence itself is not copied into the receipt.
Every observed wrapper, SQL and module body still requires author-equivalent
proof. Receipt validation checks the legacy structural keys; the shared
primary-change evaluator establishes these semantic guarantees before producers
copy the proof.

`derivedChanges` explains preservation under the shared primary-change contract;
it grants no authority. The daemon copies the latest passing in-lease result.
The hammer CLI accepts an optional final argument naming its gate JSON snapshot,
requires a passing gate with matching `expectedHead` and `liveHead`, and retains
the same evidence in owner receipts or isolated-worker requests. Existing
exact-head recent-merge confirmation remains required.

## Receipt ownership and executed refusals

A merge operation has one receipt owner. Direct adapter callers use the adapter
seam by default. `writeAdapterPullRequestMerge` accepts `recordReceipt: false`
in its options to delegate all receipt writing and confirmation to the caller.
Fast-merge uses this option: `processFastMergePR` alone records the final outcome
across adapter, admin fallback and transport retries. A successful adapter merge
or a successful admin fallback therefore publishes one success receipt, with no
intermediate adapter refusals. Reconciliation of a manual merge at any head
updates terminal state without claiming automation execution.

An executed refusal is an explicit negative merge decision, not an unknown
outcome. The shared `isExecutedMergeRefusal` helper admits these closure reasons:
`permanent-merge-rejection`, `builder-token-merge-refused`,
`predicate-not-eligible`, `gate-not-eligible`, `github-gate-red`,
`github-gate-not-green`, and `primary-change-reverted`. These include deliberate
policy/eligibility decisions under a held lease, even before calling GitHub.
The daemon additionally requires a permanent decision and no accepted merge.
The hammer CLI filters all other refusal reasons. Superseded and deferred
hammer outcomes, gate-read failures, gate timeouts, transient retry exhaustion,
unknown primary-change state, unclassified errors and failed confirmation reads
supply no refusal receipt. A zero merge exit status or accepted-merge marker
prevents the hammer from writing a refusal even if confirmation later fails;
the closure audit still records the deferred outcome.

Pre-acquire `hammer-lease-admission` refusals are also exempt: live label/draft
gates defer, head movement supersedes, and closed PRs cannot enter the lane.
No held-lease merge decision or execution has occurred. The AMA audit records
`merge-lease-admission:<reason>` instead; these attempts do not claim executed
refusal coverage.

At the adapter seam, a returned `ok: false` is refusal evidence only when it is
`failureClass: "permanent"` and excludes stale-head, missing-resource,
transient and already-merged/idempotent responses. Both returned and thrown
refusals use `permanent-merge-rejection`. Thrown errors must
contain a parsed JSON payload with `ok: false` and `failureClass: "permanent"`,
with the same exclusions. Unstructured, timeout and transport errors supply no
receipt. Callers can pass `producerClass`, `hqRoot` and `logger` in the adapter
options; defaults remain `ama-daemon`, `env.HQ_ROOT` and `console`.

## Publication and failure behavior

The writer requires the current username to match `.hq/config.json`'s
`ownerUser` and the HQ root to belong to that user's UID. Audit parents must be real owner-UID directories and may be group-writable
(the canonical audit directory is `0775`), but never world-writable. The leaf
`automation-merge-actions` directory must also reject group writes.
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
minutes of the timestamp captured when the hammer issued the merge, rather
than when delayed confirmation finished. The outer hammer alarm is 60 seconds
to cover the three-attempt read budget. The hammer CLI and adapter's direct
`gh pr view` confirmation use `execGhWithRetry`: at most three transient-read
attempts, 500/1000ms backoff, and a 15-second subprocess timeout per attempt.
Timeouts, EIO, transport errors, rate limits and HTTP 5xx are retryable.
Permanent permission failures are not retried; rejected authentication uses the
helper's separate, single token-refresh attempt. Malformed JSON or an unverified
head produces no success receipt.

Daemon callers use `recordMergeActionBestEffort`, which logs receipt-write
failures and preserves the merge result. A second consecutive publication
failure emits an error-level alert, deduplicated until successful publication. The adapter likewise warns after
verification exhaustion without reissuing the merge. The CLI exits non-zero on
verification or publication failure except for the isolated-worker handoff below.
Receipt failure never changes the existing authority flags or eligibility gates.

## Isolated-worker request handoff

When the CLI is not running as `ownerUser`, it can instead append a request to
`$HQ_ROOT/workers/<HQ_WORKER_ID>/merge-action-requests/<uuid>.json`, provided a
valid worker ID (excluding all-dot IDs) and `HQ_LAUNCH_REQUEST_ID` (or `LAUNCH_REQUEST_ID`) are present.
The request has the same record fields plus `launchRequestId`. Its directory
uses mode `0750`, its file uses `0640`, and the file is owned by the worker UID
with the HQ root's GID. Requests are written to a temporary file, attributed and permissioned, then
renamed into place; failures remove the temporary file. Worker claims are
untrusted: HQ-owner teardown must independently re-verify the exact head and
merge time with GitHub before publishing trusted receipts. That consumer belongs to the Agent OS superproject; this
repository owns the writer and request format.
