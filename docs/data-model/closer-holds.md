# Closer hold records

Owner: AMA closure. Source: `src/ama/hold-record.mjs`.
Storage adapters: `src/ama/closer-hold-records.mjs`.

HOLDCONTRACT-01 gives active closer holds one embedded contract while retaining
existing filenames, audit evidence and delivery receipts. The writers are
`hammer-stop-hold.mjs` (deterministic and transient stops),
`companion-stop-wait.mjs`, `operator-label-gates.mjs` and `stacked-base.mjs`.
Merge leases, dispatch intents and operator mutation receipts keep their own
lifecycle contracts; they are not additional closer hold stores.

| Field | Contract |
|---|---|
| `holdVersion` | `1` for the shared shape. |
| `holdType` | `hammer-stop`, `operator-label` or `stacked-base`. |
| `owner` | Component or lane acting next: `closure-recovery` or `operator`. |
| `awaits` | Nonempty array of machine-checkable predicates; any satisfied predicate releases. |
| `deadline` | Absolute ISO timestamp; expiry escalates, and never grants merge or dispatch authority. |
| `onDeadline` | Existing alert event or stacked-base comment marker. |
| `reason` | Existing stop or hold reason. |
| `repo`, `prNumber`, `headSha` | Subject identity; stacked-base records remain PR scoped. |
| `escalatedAt` | Optional successful poll escalation receipt. Existing `pagedAt`, `alertedAt` and `commentedAt` receipts also suppress duplicate escalation. |

`createHoldRecord`, `assertHoldRecord` and `writeHoldRecord` reject a missing
owner, deadline, reason, escalation identifier or predicate array before
persistence. Each migrated store validates active holds before atomic writes.
Legacy normalization supplies an owner, predicates and the existing owner's
paging horizon. A versioned record missing required fields is invalid rather
than silently repaired. Readers preserve legacy release and delivery evidence.
The hammer-stop owner explicitly upgrades valid version-1 deterministic holds
with missing gate provenance or predicates before evaluation in admission and
skipped-subject sweeps. Unknown provenance defers anchoring; upgrades preserve
deadlines and delivery receipts and use the existing persistence fences.
The hammer-hold read projection also reports `deadlineSource` from a stored
deadline, retry/wait time, first observation or companion merge. It is read-only
provenance: TTM cannot claim ownership from an unanchored normalization default.

Predicates are data, never executable expressions:

- `head-change`, `base-change`, `mergeability-change`, `checks-change` and
  `review-change` compare their stored `from` reading with the owner's current
  observation. Missing observations do not prove movement; UNKNOWN mergeability
  cannot release. Check and review fingerprints retain their existing producers.
- `event` names a positively observed recovery fact, including operator release,
  recovered GitHub gates, computable primary-change evidence, conflicts,
  successful stacked-base inspection and cleared operator-label gates. CI waits can also release on an observed
  check fingerprint change. Review-finding waits never use CI greenness as
  release evidence.
- `gate-revision-change` compares `from: { serviceRevision, predicateVersion }`
  against the owner's loaded service revision and optional predicate version.
  Both readings of a component must be nonempty strings to prove a difference.
  Deterministic hammer refusals alone await this predicate; a missing revision
  does not release. The poll cache includes revision observations.
- `retry-at` stores an absolute `at` timestamp. Transient hammer retries retain
  their five-minute bound and fallback precedence after other releases.
- `companion-merged` observes a named dependency merge. Companion holds use
  `gitlink-contains-commit` to require the expected repository, PR and submodule
  path plus the existing authoritative merge/ancestry proof. Merge alone remains
  a phase event and cannot dispatch a closer before the gitlink contains it.

`evaluateHoldRecord` is the only predicate evaluator. Each watcher poll has a
bounded-lifetime evaluation scope. Existing owners evaluate with their complete
observations; the final sweep evaluates holds for discovered open subjects that
were skipped by scheduling. Cached results require identical record, time and
evidence; fresh inputs, recovery events or receipts are evaluated again within
the poll. Operator-label CI clearance applies the stored own-context exclusions
and required gate names; missing gate arrays or exclusion policy cannot prove
clearance. It adds no remote read. Hammer receipts require a current matching audit stop;
a leftover receipt cannot create a hold after the audit clears. Missing review snapshots,
check rollups or own-context policy cannot stand in for fresh evidence. Expensive
companion and primary-change probes retain their existing cadence. The existing
`readHammerStopHoldForHead` export normalizes records, and
`readCloserHoldRecords` exposes all three stores for owner-resolution consumers.
GitHub subject snapshots retain the observed repository default branch from the
existing adapter response, allowing the sweep to recognize stacked-base clearance
without guessing a branch or adding a remote request.

Immediate hammer/operator-label paging retains an immediate deadline. Historical
history-read grace remains ten minutes; companion waits retain 25 hours from
first observation or authoritative merge. A stacked-base read failure retains
its one-minute retry, while a merged-parent hold retains its immediate retarget
comment escalation. The poll sweep logs a pending stacked-base escalation and
leaves comment delivery with the existing guard; it creates no second outbound
notification path. A release wins over deadline escalation. Successful delivery
receipts survive restart; a shared process receipt also suppresses repeats after
a write failure or a superseding observation during delivery. Failed delivery retries. Poll mutations use an
exclusive claim and compare the unchanged file before replacement, including
after yielding to alert delivery. Existing per-head/dependency page suppression
and retention remain in effect. The process receipt cache retains at most 10,000
keys, evicting the oldest on overflow; durable receipts remain authoritative.
The poll claim uses the existing load-aware 60-second paging lease (five minutes
for stacked-base comment budgets) so an orphaned
file cannot block sweeps forever. Fresh claims remain exclusive and cleanup checks
the acquired inode before removing a claim.

Release only ends the wait. Review, findings, terminal lifecycle, eligibility,
leases and retry/lifetime caps continue to decide the existing dispatch paths.
No configuration key, CI check, override label or merge authority is added.
