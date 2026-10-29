# SEV3 LAC-2127 — Ancestral migration metadata repair refused

Incident date: 2026-10-29. Severity: SEV3, merge availability.
Issue: [LAC-2127](https://linear.app/laceyenterprises/issue/LAC-2127).
Disposition: source correction and offline proof prepared for normal cross-model
review. Source merge, deployment and organic queue recovery remain outstanding
and distinct. No unsafe merge was observed or authorized by this work.

## Impact and preserved evidence

The rescue's native saved verdict in
`/private/tmp/os-rescue-20261029-1413/9692-primary-details.json` refuses Agent OS
PR9692 at `065b0c7e7aeb03af64392c711526d9f104e166b0` with
`primary-change-reverted`, migration diagnostic `chain-non-increasing`.
Protected primary is `60dc71289dcf307a1703576f5c5eab041c4826c0`.
Reversal authorization remains absent; the correction creates no such authority.

The checked-in [immutable corpus](../../test/fixtures/migration-renumber-9692/README.md)
contains the actual wrapper/SQL/module/registry blobs, complete directory trees,
all seven snapshot comparisons and adjacent ancestry. Protected-primary
selection comes from the existing native evidence; this fixture exercises the
mechanical proof from that trusted boundary. It does not replace provenance
selection or edit the stored primary. The corpus documents transport projections.
The rescue partial clone lacked objects; an attempted read could not hydrate
its owner-protected object store. Subsequent evidence reads used read-only
GitHub APIs, without repairing or modifying that checkout.

A read-only PR lookup during investigation reported newer head
`b6e5c2653306530503613aad085478f51fbf04de`. All reproduction remains pinned
to the dispatched immutable head. A successful old-head replay establishes no
claim about current-head review, deployment, eligibility or queue recovery.

## Root cause: the initial diagnosis was incomplete

The primary is an ancestor, independently confirmed by the `ahead` comparison
and exact seven-commit parent graph. Actual filename slots are
`309 → 310 → 311 → 311 → 309 → 312 → 312 → 312`; declared revisions are
`309 → 309 → 311 → 311 → 312 → 312 → 312 → 312`.
The reset to filename 309 occurs at `ffbfc07236d832c4dd7a0c8dc92ea10b34010767`,
when the declared revision advances to 312 and r312 is introduced. The later
`e306e2c5451322833b64033bf9376a1dd454bb9a` renames the file to 312 without
changing its blob. Repeated identical wrappers collapse only after all snapshots
have been checked.

The existing complete snapshot proof successfully checks mechanical bodies and
SQL/module/registry continuity, then chain construction uses filename order as
revision order. Any non-increasing filename requires overall `diverged`
ancestry. A valid descendant repair therefore fails closed. Merely changing
`<=` to `<` would still reject the actual 311-to-309 filename reset. Treating
all ancestral filename decreases as mechanical would instead lose the boundary
against real revision rollback. AR1604's deployed lexical/path/suffix fixes
are preserved; none is repeated here.

## Correction and independent safety evidence

The additional exception is restricted to SQL-origin Alembic wrappers. Every
snapshot must still match the protected author wrapper and SQL. Every observed
module must be a literal declaration embedding that SQL and preserving its
normalized operation/downgrade identity; its registry must be exactly the one
module insertion against its independently selected base. Module disappearance
or a hidden intermediate operation change still refuses.

Every Alembic chain records the verified declared revision. Declared revisions
cannot decrease, including diverged histories, or exceed the final slot. The
final declaration must equal the final filename slot. An ancestral filename
reset additionally requires strictly advancing declared revision; equal slots
permit only a same-path metadata correction.

The new exception independently certifies the selected predecessor wrapper,
SQL and ordinal module in the primary and every snapshot against that snapshot's
base, by exact immutable blob equality. The corpus's parents are 308, 309, 310
and 311; their operation hashes match the base. Before module introduction,
the entire registry must also equal the base. Missing, ambiguous, unreadable or
changed parent operations cannot borrow authority from a matching revision
identifier. The entire diagnostic range must match the immutable ancestor
commit count; each adjacent pair must independently be exactly one commit ahead.
Evidence is transient: `metadataRepair`, ordered `parentOperations`, declared
revision chain and head-bound `ahead` ancestry. No persistent schema changes.

Sibling audit covered both producer and `verifiedMigrationRenumbers` consumer,
unchanged-author observations, SQL-only/module introduction, paired-module and
non-Alembic proofs, snapshot completeness, predecessor selection, range bounds,
read budget/deadline and `checkPrimaryChange`. Existing strictly increasing and
diverged proof paths remain available; real declared-revision decreases now
fail closed in both. Existing merge predicates, review authority, terminal PR
handling and watcher claim CAS are unchanged. No config keys/loaders, CI jobs,
checks, overrides or rollout flags were added.

The dispatch hardening contracts remain in force:
`merge.finding-remediation-and-authoritative-terminal` and
`adversarial-pipeline.no-action-on-terminal-pr` still require all findings
remediated and authoritative terminal-state handling; this proof creates no
review or terminal-PR exception. Existing regression siblings are
`test/watcher-claim-loop.test.mjs` and `test/generated-index-replay.test.mjs`
(PMSC-14). `config-schema.multi-loader-parity` requires coordinated strict
loaders for any CFG change; this patch changes no CFG section or loader. The
worktree/deploy scars are addressed by keeping edits and publication in the
provisioned worker tree and leaving deployments and sibling worktrees alone.
The current-head verdict scar remains a live owner responsibility: pinned
old-head reproduction cannot establish review currency on a moved head.
Memory searches for the initial symptom and expanded predecessor/filename-reset
scope returned no matching records; the injected scars and local runbooks
were retained as context. Linear shared agent notes were unavailable (tool
not found), rather than assumed absent.

## Regression and validation

Five fresh offline replays of the actual corpus against the original module
all return `chain-non-increasing`; five against the corrected module all return
one consumer-verified proof, with 91 immutable reads each (existing limit 512).
Ancestry/base reads use metadata-only comparisons to avoid reconstructing file patches.
Concurrency and timeout policies are unchanged. No production race was induced
or claimed. The ordinary primary-change predicate also accepts the pinned
corpus after the mechanical proof; this is not live merge authorization.

`test/primary-change-migration-metadata-repair.test.mjs` covers the actual history
and a same-filename repair, intermediate and final operation mutations, parent
wrapper/SQL/module changes, early registry changes, actual declared-revision
decreases, filename reset without advancement, invalid identities/overshoots,
missing/skipped history, invalid ancestry and damaged consumer bindings.
Existing renumber/rebase suites continue to cover malformed blobs, missing or
truncated trees, read budgets, deadlines, paired modules and module disappearance.

Repository validation (all commands bounded by `worker_validation`, 900 seconds):

- Final focused migration suites: 143 passed, zero failures.
- `npm run lint`: exit 0, zero errors; 153 existing repository warnings.
- `npm run typecheck:contracts`: exit 0.
- `bash demo/research-finding-walkthrough.sh`: exit 0, three byte-stable deliveries.
- Full `npm test`, with GitHub token variables removed: 16,899 tests,
  16,887 passed, 11 skipped, one failure, exit 1 after 757 seconds.
  The unchanged `test/derived-artifacts.test.mjs:335` cancellation test fails
  at its process inspection (`spawnSync ps EPERM`). The worker sandbox also
  refused an independent shell `ps` read before this run. This process-inspection
  restriction is unrelated to migration proof; the test, its assertions and
  the environment policy remain unchanged. Per the dispatch baseline-failure
  rule, this limitation is reported rather than repaired or waived in this PR.
  Normal managed publication and required GitHub CI still apply.

The full suite included the terminal-PR/claim and generated-index regression
siblings. No broad rerun was used to conceal or replace the recorded failure.

## Operational acceptance remains separate

This merge-gate change requires normal cross-model review, all findings
addressed, required CI and governed source merge. Deployment belongs to the
runtime owner through the normal deployment process. The existing post-merge
natural-renumber observation remains the smoke promise: inspect an organic
merge receipt for the derived classification and all pinned evidence. For this
incident, assess the then-current PR9692 head with fresh native proof, review
and CI after deployment; observe organic queue recovery independently.

This worker does not deploy, restart services, change flags/grants/queue/lease/
DB state, mutate PR9692 source/history, manufacture provenance, edit stored
primary evidence, bypass the gate or merge PR9692. Publication of the source
PR does not close those operational acceptance items.
