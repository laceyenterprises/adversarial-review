# Data Model - Reviewer Credential Outages

**Owner:** reviewer OAuth credential outage suppression
**Store:** `data/reviewer-credential-outages/`
**Source of truth:** `src/reviewer-cascade.mjs`
**Runtime surface:** `src/reviewer-cascade.mjs`, `src/pollonce-phases.mjs`, `src/reviewer-spawn-settle.mjs`

## Purpose

`data/reviewer-credential-outages/` stores one durable JSON file per reviewer
model when OAuth failures indicate a model-wide credential outage. The watcher
consults this state before spawning another reviewer for that model so one bad
credential does not burn every PR's review budget or flood the operator with
duplicate failures.

The store is model-scoped, not PR-scoped. It is separate from
`data/cascade-state/`, which still owns the per-PR transient backoff window.

## Files

Directory: `data/reviewer-credential-outages/`

| File | Shape | Contract |
|---|---|---|
| `<encodeURIComponent(model)>.json` | Credential outage state object | Durable per-model outage state. The writer uses tmp+fsync+rename so readers never rely on a torn JSON file. Missing or unreadable files are treated as no credential outage state. |

## State Object

| Field | Shape | Contract |
|---|---|---|
| `reviewerModel` | string | Normalized reviewer model name that owns the outage file. |
| `active` | boolean | `true` once OAuth failures have crossed the distinct-PR threshold, or after a previously active outage records another failed probe. |
| `reason` | string | Stable outage reason in the form `reviewer-credential:<model>`, used in parked-row failure messages. |
| `startedAt` | string or null | ISO-8601 timestamp from the first failure that activated the outage. Preserved while the outage remains active. |
| `nextProbeAt` | string or null | ISO-8601 timestamp when the next recovery probe may be reserved. This is advanced by the pre-spawn reservation path and may be preserved by a failed probe when the reservation already set the next window. |
| `lastProbeAt` | string or null/absent | ISO-8601 timestamp of the last recovery probe reservation. This is written when a hold expires so one queued PR can test the credential while later PRs stay parked until the next window. |
| `failures` | array | Recent distinct PR failures inside the rolling credential window. Each entry stores `repo`, numeric `prNumber`, and ISO-8601 `failedAt`. |
| `distinctPrCount` | number | Distinct `(repo, PR)` count represented in `failures` after the rolling-window filter. |

## Operational Contract

- `recordReviewerCredentialFailure` opens the outage only after OAuth failures
  hit the distinct-PR threshold inside the rolling credential window. Once
  active, later failed probes keep the outage active even if only one fresh PR
  remains in the rolling window.
- `shouldPauseReviewerModel` holds reviewer spawns for an active model outage
  until `nextProbeAt`. The watcher first calls it with `reserve: false` as a
  read-only admission check, then calls it with reservation enabled immediately
  before the actual spawn path. When the hold expires, the reserving call
  records `lastProbeAt`, advances `nextProbeAt`, returns `probe: true`, and
  lets one normal reviewer spawn path test whether the credential has
  recovered. Later spawns remain held until the next probe window. A successful
  reviewer attempt clears the outage; a failed `oauth-broken` probe records a
  fresh failure while preserving the reserved retry window when it is still in
  the future.
- The helper returns `nextProbeAfter` from persisted timestamps for watcher
  spawn-decision logs; the persisted source is `nextProbeAt`.
- `clearReviewerCredentialOutage` removes the model file after a successful
  reviewer path. The settle path also re-arms rows parked with
  `[outage-transient:reviewer-credential:<model>]`.
- The files contain transient credential failure diagnostics and no secrets or
  review bodies.
