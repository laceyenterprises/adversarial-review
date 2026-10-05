# Data Model - Fast-Merge Audits

**Owner:** Fast-merge close processing
**Store:** `data/fast-merge-audits/`
**Source of truth:** `src/fast-merge-processing.mjs`
**Runtime surface:** `src/fast-merge-audit-storage.mjs`, `src/fast-merge-audit-recovery.mjs`, `src/ama/closing-keywords.mjs`

Skip and close records share this directory with distinct `auditType` values.
Close records use `kind: fast-merge-audit`, `schemaVersion: 1`, and
`auditType: fast-merge-close`. `buildFastMergeCloseAuditEntry` defines the close
fields; `writeFastMergeCloseAuditEntry` writes them atomically. Terminal audit
write failures retain the row's pending retry marker for recovery. See
[State Machine](../STATE-MACHINE.md) for authorization and state transitions.

| Field | Shape | Contract |
|---|---|---|
| `repo`, `pr_number`, `sessionUuid`, `recorded_at` | string, number, string, ISO timestamp | Record identity and append time. |
| `action` | string | Close-path outcome, including `merged`, `closed`, `blocked` and `requeued`. |
| `authorized_head_sha`, `fast_merge_authorized_head_sha`, `current_head_sha`, `merged_head_sha`, `merge_sha` | nullable strings | Exact-head authorization and observed merge evidence. |
| `manual_merge_detected`, `closed_without_merge`, `head_changed`, `veto_detected`, `label_removed` | booleans | Observed close/requeue conditions. |
| `failure_reason`, `refusal_reason`, `check_conclusions`, `requeue_path`, `requeue_result`, `merge_stdout`, `merge_stderr` | nullable evidence | Caller-provided gate, requeue and CLI evidence. |
| `closingKeywordRewrites` | array | Explicit message rewrites, title first then body. Defaults to `[]`; absent on older records. |

Each rewrite is `{original, referencedNumber, referencedRepo, replacement}`.
`original` and `replacement` contain raw author-text snippets, including
whitespace; escape them when rendering. `referencedNumber` is numeric;
`referencedRepo` is `null` for local `#N` / `GH-N`, or the qualified owner/repo
for `owner/repo#N` and GitHub issue/PR URLs. Actual self-PR references are exempt.
For a detected manual merge, rewrites describe the daemon's attempted message,
not the message used by the other actor. An empty array does not attest that
other merge paths or individual commit messages are sanitized.
