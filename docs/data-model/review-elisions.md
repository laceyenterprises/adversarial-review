# Data Model - Review Elisions

**Owner:** reviewer prompt-budget evidence
**Store:** `data/review-elisions/`
**Source of truth:** `src/reviewer.mjs` (`persistReviewElisions`)
**Runtime surface:** `src/reviewer-harness.mjs` (`elideLongDiffLines`)

## Purpose and key

Chunked oversized reviews preserve file units that fit and split oversized
units by line. Only a diff content line that cannot fit with its file and active
hunk headers is eligible for a bounded UTF-8 preview. Elided additions add a
synthetic blocking finding even if all chunk reviewers are clean. Elided
context and deletions add non-blocking evidence notes, since they introduce
no new content. This store preserves the evidence; it is not
merge authority. The raw diff plus context hard ceiling is checked before
elision to bound preprocessing work.

Files are `<repo-slug>-<prNumber>-<headSha>.json`, where `/` becomes `--`:
for example `owner--repo-123-<sha>.json`. The explicit reviewer head falls back
to the review workspace snapshot head. Missing heads skip persistence with a
warning instead of writing a shared `-null.json` file.

## Fields

| Field | Shape | Contract |
|---|---|---|
| `repo`, `prNumber`, `headSha` | string, integer, string | Repository, PR and immutable review snapshot head. |
| `elisions` | array of objects | One entry per partially withheld diff line. |
| `elisions[].path` | string | Old-side path for deletions; new-side path otherwise. Deleted files use their old path rather than `/dev/null`. |
| `elisions[].line` | integer or null | One-based line on the named side, or null outside a recognized hunk. |
| `elisions[].side` | `old` or `new` | Side used for line attribution; headers inside hunks are treated as content. |
| `elisions[].kind` | `+`, `-`, or a space | Added, deleted, or unchanged context line. Only added-line elisions create synthetic blockers. |
| `elisions[].diffLine` | integer | One-based line in the original diff. |
| `elisions[].byteLength` | integer | UTF-8 bytes of the original diff line, including its diff prefix, excluding newline. |
| `elisions[].sha256` | hex string | SHA-256 of those original bytes. |

## Persistence and retention

Writes are atomic and best-effort; failures log a warning and cannot fail a
completed review. Repeat reviews of the same head overwrite the evidence file.
Legacy entries may omit `side` and `kind`. The posted review also contains the path,
line, byte count and digest, so merge blocking does not depend on this file.

There is no automatic retention sweeper. The reviewer operator owns archival
and cleanup after PR closure and after the posted review's evidence has been
retained for the required audit period. Preserve open-head artifacts.
