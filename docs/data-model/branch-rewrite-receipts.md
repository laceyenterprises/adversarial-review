# Successful branch rewrite receipts (HOLDERPROOF-01)

Owner: successful leased Git publisher in remediation, auth recovery or the
finalization queue.

Source of truth: `src/branch-rewrite-receipt.mjs`.

Store:
`<HQ root>/dispatch/branch-rewrites/<encoded-repository>/<encoded-branch>/<uuid>.json`.

| Field | Meaning |
|---|---|
| `event` | `worker.branch_rewritten` |
| `repo`, `branch` | Transport-normalized repository (`github.com/owner/repo`) and branch name; directory names use Python-compatible percent encoding |
| `oldHead`, `newHead` | Exact successful push's expected-old lease and immutable candidate, respectively; nonzero 40-character hexadecimal tips accept either letter case |
| `actor` | `review-service:remediation`, `review-service:auth-recovery`, or `review-service:finalization-queue` |
| `launchRequestId` | Worker launch identity when present; otherwise null for service workspaces |
| `recordedAt` | UTC receipt-write time |

Only successful rewrites produce evidence. Ordinary fast forwards, failed pushes
and unproven observations do not. Native auth publication proof is recorded before
fallible live-head verification. Receipts use the existing Agent OS schema;
there is no new ledger table or lifecycle enum. Files request 0660 and directories
2770, retain the dispatch group, and are fsynced/atomically renamed before return.
Filesystem owner/group metadata is audit evidence, not authentication.
Repository identity follows the actual push destination. Ordinary remediation
and auth recovery resolve origin's push URL; scoped workflow auth recovery uses
its explicit HTTPS destination instead of origin. The queue uses its head
repository. All three publishers check ancestry before recording rewrite evidence;
an unreadable ancestry check preserves publication success with a recovery error.

Storage errors preserve published status and return/log `rewriteReceiptError`
with branch, old/new tips, actor and `repo` (null when resolution failed). Recovery and
owner-reviewed retention follow the [receipt runbook](../follow-up-runbook.md#successful-branch-rewrite-receipts-holderproof-01).
No automatic expiry or push retry is introduced. Agent OS bundles holder history
before consuming receipt or independent GitHub force-push evidence for release.
