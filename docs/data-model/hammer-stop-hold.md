# Data Model - Hammer Stop Hold

**Owner:** AMA closer retry admission
**Store:** `data/follow-up-jobs/hammer-stop-hold/`
**Source of truth:** `src/ama/hammer-stop-hold.mjs`
**Runtime surface:** `src/ama/dispatch-closer.mjs`, `src/ama/audit.mjs`, `src/checks-summary.mjs`

## Purpose

After a hammer stops without merging, the closer holds another attempt until
an input changes, and pages once per head with the recorded predicate. Daemon
failures do not create hammer holds. The producer and legacy compatibility
rules are defined in the [AMA audit contract](ama-audit.md).

## Files and shape

One atomically rewritten JSON object per `(repo, PR)` lives at
`<repo-slug>-pr-<number>.json`. The slug replaces every character outside
`A-Za-z0-9._-` with `-`, including `/`. There is no schema-version field.

| Field | Shape | Contract |
|---|---|---|
| `heads` | object keyed by head SHA | At most eight entries retained, newest `firstObservedAt` first. |
| `heads[sha].stopKey` | string | Audit file head, attempt number (or array index), and attempt start/timestamp identify one stop. A different stop creates a new hold entry. |
| `heads[sha].predicate` | string | Recorded stop reason, normalized to one line and capped at 120 characters, or `reason-not-recorded`. |
| `heads[sha].firstObservedAt` | ISO timestamp | First closer observation of this stop. |
| `heads[sha].inputs` | object | Baseline `{ headSha, baseSha, mergeability, checks }`. SHA fields are strings or null; mergeability is `MERGEABLE`, `CONFLICTING`, or null. `checks` is a sorted, pipe-joined string of lowercase check identities and normalized latest states. |
| `heads[sha].pagedAt` | ISO timestamp or null | Successful operator alert delivery. Carried forward for subsequent stops on the same head. |
| `heads[sha].releasedAt` | optional ISO timestamp | First observation of changed inputs. A released stop remains released across ticks and restarts. |
| `heads[sha].releasedBy` | optional string array | Changed dimensions: `head`, `base`, `mergeability`, `checks`. |
| `heads[sha].releasedInputs` | optional inputs object | Inputs at release; used as the next stop's baseline if another hammer stops on this head. |

## Recovery and retention

The closer reads fresh audit evidence on each tick; the hold file alone cannot
create a decision. Known current SHA or mergeability readings can release an
unknown baseline; missing current SHA readings and `UNKNOWN` mergeability
cannot prove change. Checks use the canonical latest-run and own-status
exclusion helpers: only matching `StatusContext` entries (or legacy entries
with `context` and no type) are excluded. A same-name external `CheckRun`
remains an input. Missing/non-array rollups are represented as an empty string.

Release permits ordinary eligibility, lease and retry-cap checks; it does not
authorize dispatch or merge by itself. A new head starts its own entry. A new
stop on an existing head carries its page marker and uses the prior release
inputs when available. The `ama_closer.hammer_stop_hold` alert retries on
delivery failure. A successful page also sets process-local debounce so failed
state writes cannot page every tick; that fallback resets on process restart.
Unreadable/malformed hold files are treated as empty state and rebuilt from
audit evidence. Write failures are logged and the in-memory decision still
applies for that tick. Retention is capped at eight heads per PR, with no TTL.
