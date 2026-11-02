# Data Model - Next Action Shadow Observations

**Owner:** NXA-02 closure observation and rollout owner
**Store:** `<watcher root>/data/next-action-shadow/disagreements.jsonl` and `.jsonl.1`
**Source of truth:** `src/pr-next-action-shadow.mjs` (`appendBounded`, `compare`, `nextFields`, `shadowNextAction`)
**Reader:** `src/next-action-disagreements.mjs`, `bin/next-action-disagreements.mjs`

## Purpose and ownership

The shadow appends diagnostic comparisons between legacy ownership and the
shared next-action decision. These records grant no dispatch or merge authority;
All adopted consumers now execute projections of the shared decision. Historical
legacy adapters remain available only for observational comparison. The shadow log itself grants no authority. The watcher and closure consumers write
under their configured root. The rollout owner classifies the evidence through
the read-only report CLI, with optional dispositions in a separate private file.

## Record contract (`nxa-shadow/v1`)

Each line is one JSON object followed by a newline. Both variants carry:

| Key | Shape and meaning |
|---|---|
| `schema` | Literal `nxa-shadow/v1`. |
| `kind` | `disagreement` or `overdue`. |
| `observedAt` | ISO timestamp from the observer's clock. |
| `source` | Consumer name, or `unknown`. |
| `subjectKey` | Opaque subject identifier, or null. |
| `passId`, `generation` | Pass identifier and numeric generation, or null when unavailable. |
| `head` | Observed head identifier, or null. |
| `next` | Decision projection described below. |
| `evidenceRefs` | Array of source state/provenance references and row-specific references. No raw snapshots. |

`next` contains `action`, `actor`, `reason`, `row`, nullable `round` and
`attempt`, `deadline`, `decisionKey`, and `queue`. Actions, actors and row
semantics are defined in [the reason inventory](../NEXT-ACTION-REASON-INVENTORY.md).
`deadline` is null for done/hold decisions; otherwise it contains nullable ISO
`at` and `anchoredAt`, `anchorSource` (`owner`, `durable`, `observed`, `none`),
`class` and `budgetMs`. `queue` contains `intent` and nullable `deferredBy`.
`decisionKey` is the first 32 hex characters of SHA-256 over subject, head,
action, actor, reason, round, attempt and deadline anchor.

For ledger-derived launches, the consumer projects `launch.attempt`, falling
back to the observation's `attempt` and then null; zero is preserved. Terminal
no-merge recovery (R07) records that attempt, while retry admission (R08)
records the next attempt (current plus one), or null when unavailable.

Disagreement records additionally contain:

- `fields`: the differing members of `action`, `actor`, `reason`.
- `legacy`: `action`, `actor`, `reason`, nullable `legacyOwner` and `legacyReason`.
- `caseKey`: first 24 hex characters of SHA-256 over subject, head, legacy triple
  and next triple; source, generation and deadline do not affect case identity.

Overdue records additionally contain `ageMs`, the observer's time minus the
decision's due time. They omit `fields`, `legacy` and `caseKey`. Overdue reports
are deduplicated by decision key in process memory (bounded to 2048 entries),
not durably; a restart or eviction permits another report. Disagreements are
appended for each observed comparison. Agreements produce no comparison record.

## Retention and failure behavior

The writer creates the directory recursively, then checks the active file size.
At or above 16 MiB, it renames the active file to `.jsonl.1`, replacing the
previous rotation, and appends to a new active file. There is one retained
rotation and no time-based expiry. This is a best-effort size bound, not a
transactional cap: an append may cross the threshold and concurrent writers
are not serialized. The log has no uniqueness constraint or delivery guarantee.

Directory, stat, rotation or append failures cannot affect legacy control flow.
A stat failure is treated as size zero; other write failures are caught as
`sinkError` in the observation result, without console output or propagation.
Records can be lost. Offline tests leave the shadow inert unless a sink is
installed; fixture sinks replace the file writer.

The report reads only the active file by default (8 MiB tail, configurable up to
64 MiB); `--file` can select the rotation. A partial first line is discarded when
reading a tail. Missing files produce an empty report marked `missing`; malformed
lines are counted and skipped. Other read failures propagate to the read-only
CLI, never to a closure consumer. Reports do not rewrite or repair the log.

Overdue paging is separately opt-in through `AMA_NEXT_ACTION_OVERDUE_ALERTS=1`
and uses the existing closure-wait debounce/refund path. The log is telemetry,
not the durable alert receipt. See [the shadow runbook](../RUNBOOK-ama-closure.md#shared-next-action-shadow-nxa-02).

NXA-05 adopted consumers may replace the cached immutable pair after changed
proof, daemon gate or queued PR facts. Unchanged observations reuse it. A
qualified existing daemon repair fallback is recorded as head-bound
`progress.daemonRepair` admission evidence; the common policy still applies
review proof, remaining rounds, automatic stops and caps first. This is neither
a merge certificate nor a new refusal. Shadow sink/alert availability has no
execution authority.

NXA-05 also carries the existing daemon's validated terminal-head observation
into the shared generation before mutation. That proof names both the reviewed
and target heads; a later head cannot inherit it. The ordinary executor still
revalidates HCP, exact-head proof, primary-change preservation, checks and leases.


NXA-07: successor selection belongs to `nextAction(snapshot)`. This store
retains execution/scheduling evidence and projects the selected action, actor,
reason, head, anchored deadline, decision key and queue intent. Diagnostic reason
text is not an eligibility registry. Automatic stops and unreadable evidence
retain recovery ownership; only explicit hold/draft/disabled intent selects the
operator. Existing durable attempt, lease, request and terminal fences remain.

## Exhausted builder-head ownership

The closure evidence policy projects `exhaustedBuilderHead` from cycle exhaustion,
current/reviewed head identity and closer ownership. Its retry-cap observation
names the reviewed-head series that spent the budget. A builder head with a stale
review uses its own persisted wait anchor; immutable snapshot derivation drops
base anchors when the head changes. These observations grant verdict admission
only; executor merge predicates remain authoritative.

## Change notes

### MLR-01: bounded read-model journals

This supersedes the uncoordinated best-effort retention and optional paging description above. `src/merge-lane-journal.mjs` owns appends to both `disagreements.jsonl` and `observations.jsonl`. Each active journal and its one `.1` rotation is capped at 16 MiB, each record at 256 KiB. A nonblocking kernel lock serializes rotation/appends; contention drops the sample. File errors never affect closure decisions. No additional pager runs in the review service.

`observations.jsonl` records `merge-lane-observation/v1`: subject/repository/PR/head, pass generation, observation time, PR state, NXA action/actor/row/reason/deadline, and tri-state launch liveness/branch custody/ownerless evidence. Process birth time is corroborated against the producer's registration timestamp; mismatches and failed reads remain unknown because registration time is not a guaranteed birth fingerprint. Retry descendants use their own process/custody record. Git inspection is read-only. Detached or unreadable refs leave `branch: null` while status inspection still runs. An unreadable status leaves custody unknown without discarding verified process liveness. Terminal dirty custody supplies ownerless evidence only for a matching head (or a legacy closer without a head), and a current live owner always takes precedence over dirty custody.

`episodes.json` is an atomic, bounded 8 MiB map keyed by SHA-256 subject identity. Each entry has the NXA fingerprint, episode start and last observation time. The same journal lock serializes cursor changes. Older samples cannot rewind it. Entries do not expire merely because observation pauses: rotation, restart and idle gaps cannot re-arm the same episode. At the size limit new observations fail closed to missing/stale telemetry; they do not reset receipts. The cursor is diagnostic and grants no dispatch authority.

The read model combines both journal rotations with fresh live inventory. Journal episode keys and status grouping both prefer `subjectKey`, falling back to `repo#prNumber` only when it is absent. Missing/stale evidence is explicit, terminal inventory wins, and only the current head supplies PR deadlines. Observed anchors use the cursor; non-owner budgets and page grace use shared capped load scaling. Owner deadlines remain authoritative. Ownerless minutes integrate known intervals only, capped by freshness; gaps remain unobserved. The separate Sentinel PRAGE producer owns durable page dedupe, not these files.

`merge-lane status [--root <dir>] [--json]` rejects invalid arguments with usage on stderr and exit code 2 before inventory reads.

The flow object reports `pages24h: null` and `pagesAvailability: aggregate-not-exposed`: the existing scoped read contract does not expose page-history aggregates. The human renderer prints this absence explicitly.
