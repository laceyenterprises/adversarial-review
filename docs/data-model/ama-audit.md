# Data Model - AMA Closure Audit

**Owner:** AMA merge authority
**Store:** `$HQ_ROOT/dispatch/audit/adversarial-merge-authority/`
**Source of truth:** `src/ama/audit.mjs`
**Runtime surface:** `bin/ama-audit.mjs`, `templates/hammer-prompt.md`, `bin/hammer-merge.sh`, `src/ama/daemon-merge.mjs`, `src/ama/closing-keywords.mjs`

## Purpose

One JSON document records closure attempts for a `(repo, prNumber, headSha)`
tuple. Its filename is `<repo-with-slashes-replaced>-pr-<number>-<head>.json`.
The writer serializes appends with a sibling lock file and writes JSON atomically
at mode `0640`.

| Field | Shape | Contract |
|---|---|---|
| `schemaVersion` | number | Current value is `1`. |
| `repo`, `prNumber`, `headSha` | string, number, string | Immutable record identity. |
| `createdAt`, `updatedAt` | ISO timestamps | First write and latest append. |
| `status` | string | Latest attempt outcome, except `succeeded` stays sticky. |
| `attempts` | array | Immutable ordered attempt history. |
| `attempts[].attemptNumber` | positive integer | Sequential, starting at `1`. |
| `attempts[].startedAt` | ISO timestamp | Append time. |
| `attempts[].outcome` | string | `in_progress`, `deferred`, `superseded`, `succeeded`, or `failed-without-merge`. Other attempt fields carry caller evidence, including `closingStatus` for gate-cap parks. |
| `reconciliation.needsRepair` | boolean | Latest append's repair signal. Present on records auto-created by append. |
| `reconciliation.lastVerifiedAt` | ISO timestamp | Latest append time. Present on records auto-created by append. |
| `closingKeywordRewrites` | optional array | Title and body rewrites computed by the daemon; absent on older records. Each item is `{original, referencedNumber, referencedRepo, replacement}`. |
| `attempts[].closingKeywordRewrites` | optional array | Per-attempt message rewrites, including hammer shell attempts. Same item shape as the top-level field. |
| `closureAuthority`, `reviewer`, `riskClass`, `flagState`, `ciMode` | optional provenance | Watcher-owned metadata, or caller-provided metadata when an append creates a missing record. `ciMode` is `github-checks` or `no-ci-bootstrap`. |

```mermaid
erDiagram
  AMA_AUDIT ||--|{ AMA_ATTEMPT : records
  AMA_AUDIT ||--o| RECONCILIATION : tracks
  AMA_AUDIT {
    int schemaVersion
    string repo
    int prNumber
    string headSha
    string status
  }
  AMA_ATTEMPT {
    int attemptNumber
    string startedAt
    string outcome
  }
  RECONCILIATION {
    boolean needsRepair
    string lastVerifiedAt
  }
```

`appendAmaAuditAttempt` may create a missing head record. That first append
includes the reconciliation block and any supplied provenance metadata. Later
appends preserve existing metadata and update reconciliation. A successful
record cannot be demoted by a later append.

For primary-change evidence, a post-lease `primary-change-read-failed` or
`primary-change-unknown` gate
writes `reason: gate-read-failed`, `permanent: false`, and the concrete reason
in `eligibilityReasons` / `preMergeReasons`. It omits `manualCloseRequired`,
so a later tick may retry the same head after GitHub reads recover.

`closingKeywordRewrites` records the explicit merge subject and body sanitization,
with title rewrites before body rewrites. `original` and `replacement` are raw
author-text snippets (including whitespace), not trusted commands or markup;
consumers must escape them when rendering. `referencedNumber` is numeric and
`referencedRepo` is `null` for local `#N` / `GH-N`, or the referenced owner/repo
for qualified and GitHub URL references. Actual self-PR references are exempt.
An empty array means no supported closing-keyword adjacency was rewritten; it
is not proof that other merge surfaces or individual commits are sanitized.
The top-level field describes the daemon's bootstrap message; immutable
attempt entries are authoritative for later attempts.

The hammer exports `HAM_AMA_TRAILERS` from the canonical dispatch-time
`composeAmaTrailers` block, preserving reviewer family, eligibility reason and
`ama-audit:<repo>:pr-<number>:head-<sha>` trace identity. Its message helper fails
closed when that block is missing; it never synthesizes substitute provenance.
