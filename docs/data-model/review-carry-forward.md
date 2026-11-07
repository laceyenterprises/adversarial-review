# Data Model - Review Carry-Forward Records

**Owner:** REVIEWCARRY-01 generated-only settled-review carry-forward
**Store:** `data/review-carry-forward/`
**Source of truth:** `src/review-carry-forward.mjs`
**Runtime surfaces:** `src/pollonce-phases.mjs` (writer), `src/ama-closure-orchestration.mjs`,
`src/daemon-clean-merge.mjs`, `src/adversarial-gate-status.mjs` (readers)

## Purpose

A posted review becomes stale when the PR head moves. A rebase that only
resolves conflicts in generated files (a fingerprint fixture, a generated
catalog) leaves the PR's own change identical, but the stale head used to start
a whole new review cycle. When the watcher is about to request that automatic
re-review, it first checks whether the settled review can carry forward. If it
can, the watcher writes one record here and does not request the re-review.

A record is evidence for exactly one `(reviewed head, current head)` pair. It
is not a merge receipt. Closers still require exact-head green CI, resolved
mergeability, zero blocking findings and the live review reconcile on the
reviewed head. A review on the current head supersedes the record.

## Carry rule

All of the following must hold, otherwise behaviour is unchanged (exact-head
re-review):

1. The reviewed head's settled verdict is `comment-only` or `approved`, its
   blocking findings are known and zero, and no remediation is pending.
2. The PR's own patch at each head (GitHub compare `<base>...<head>`, which is
   the diff from the merge base) is equal after excluding the declared generated
   paths. Comparison drops hunk headers (line numbers) and keeps every content
   line exactly, so whitespace and context changes count as changes.
3. The remaining patch is non-empty. A file list at GitHub's 300-file cap, or a
   non-generated file whose patch GitHub omitted, is missing proof.
4. The new merge base descends from the reviewed merge base. A reset onto an
   older base never inherits a review.

## Generated-path declaration

The host repository declares generated paths in
`.adversarial-review/generated-paths`. It has one root-anchored glob per line
and `#` comments. `**` crosses directories, `*` and `?` stay within one path
segment, and a trailing `/` names a whole directory. The file is read at the
current merge base, which is a base-branch commit, so a PR cannot declare its
own files generated. Callers may pass an explicit list instead. Catch-all
patterns, negations, `..` segments and any pattern that matches the declaration
itself are refused. The declaration file is therefore always compared. A
missing declaration means no generated paths, and only an exactly equal patch
carries. A file is excluded only when both its current and previous paths
match, so a rename from reviewed code into a generated directory is compared.

## Files and fields

One JSON record per `(repo, PR, current head)` is stored as
`<repo-slug>-pr-<number>-<currentHead>.json`. The slug replaces each run of
characters outside letters, digits, `.`, `_` and `-` with `__`. Records are
written once (`overwrite: false`).

| Field | Shape | Contract |
|---|---|---|
| `schemaVersion` | integer | Current value is `1`. |
| `event` | string | `review_carried_forward_generated_only`. |
| `repo` | string | Repository full name. |
| `prNumber` | integer | Pull request number. |
| `reviewedHead` | string | Head the carried review was posted on. |
| `currentHead` | string | New head the review carries to. |
| `baseRef` | string | Base ref used for both compares. |
| `reviewedMergeBase`, `currentMergeBase` | string | Merge bases of the two heads; the second descends from the first. |
| `proof` | string | `own-patch-equal-excluding-generated-paths`. |
| `ownPatchDigest` | hex string | SHA-256 of the normalized non-generated patch. |
| `generatedPathsSource` | string | The declaration path, or `explicit`. |
| `excludedPatterns` | string array | Accepted generated-path patterns. |
| `excludedPathsChanged` | string array | Generated paths touched at either head. |
| `carriedVerdict` | string | `comment-only` or `approved`. |
| `blockingFindingCount` | number | Always `0`; readers reject any other value. |
| `nonBlockingFindingCount` | number | Carried non-blocking count; strict mode still routes these to remediation. |
| `recordedAt` | ISO-8601 string | Write time. |

## Readers

- `src/adversarial-gate-status.mjs` does not report `stale-review-head` for the
  recorded pair. The rest of the gate decision runs unchanged.
- `src/ama-closure-orchestration.mjs` uses the record as the head proof for the
  shared `closerAuthoredStaleEligible` predicate when no hammer chain exists.
  The record carries no closer commits.
- `src/daemon-clean-merge.mjs` accepts the recorded pair in its moved-head check
  and validates the live head. Strict clean-review, CI, mergeability and
  in-lease re-reads still apply.

A malformed record, a record for another pair, or a record with a blocking or
unclean verdict reads as no carry-forward.

## Retention

There is no automatic sweeper. Records are small and keyed by immutable SHAs.
The operator may delete them after PR closure. Deleting a record for an open PR
makes the watcher prove the pair again on its next tick.
