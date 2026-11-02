# SEV3: findings-batch publication custody rejected native workspace repositories

Contract: FINDINGSBATCHCUSTODY-01. Ticket: LAC-2143. Date: 2026-11-02.
Status: source fix qualified offline; ordinary review, deployment and organic
runtime recovery remain gates. No live recovery was performed.

## Impact and evidence limits

The ticket's canonical health observation at 22:32 UTC reported 2,315 unresolved
non-blocking findings, oldest 228h, and `batch-launch-evidence-mismatch`,
`invalid-dropped-reason` and `invalid-finding-outcome` batch errors. These are the
reported incident totals, not a new measurement or a count attributed entirely
to one defect. The worker did not read or mutate the production review database,
queue, leases or outcome artifacts. No backlog-clearance claim is supported.

A read-only `hq dispatch status` of this worker's own LRQ on November 2 returned
`repo` and `workspacePath` equal to its provisioned absolute worktree. It was a
running launch; that observation establishes wire shape, not terminal publication
eligibility. The owner-scoped HCP launch identity matched the assigned LRQ,
branch and workspace. Open-PR search for LAC-2143 returned no active PR before
publication. HCP memory searches for publication-custody and native workspace
mismatch returned no matching records. Linear shared field-note discovery was
unavailable (`Tool get_agent_context not found`), not evidence of absent notes.

The public dispatch SDK launch snapshot was unavailable in this worker even
after read-context preparation. Therefore the presence/correctness of historical
`target_worktree` evidence remains a runtime qualification gate; no historical
launch fields were guessed. The implementation deliberately refuses missing
worktree proof. The public worker observation's recorded contract omits workspace
paths, so the fix does not invent a dependency on those unavailable fields.

## Root cause and reproduction

`publishFindingBatch` accepted non-null status `repo` only as the full repository
slug or its short name. Native `cwp_dispatch.watch.resolve_status` constructs
that field from `worker_runs.repo_path`, falling back to launch `target_repo`;
`workspacePath` comes from `worktree_path`, falling back to `target_worktree`.
A normal provisioned absolute worktree consequently failed the consumer's slug
comparison before its independently keyed launch ledger could establish custody.
The existing null/slug/foreign-slug policy fixtures missed this producer shape.

`test/fixtures/findings-custody/capture.py` uses native public ledger models,
`WorkerObservability`, `resolve_status` and its serializer against disposable
SQLite only. Its checked-in projection preserves the real terminal-success
status shape, exact synthetic workspace paths and an explicit done push
milestone. Repository, ticket, LRQ and key are synthetic fixture inputs. See its
[provenance and reproduction](../../test/fixtures/findings-custody/README.md).
The old predicate rejects this generated `status.repo`; the regression replays
it through the actual collector and verifies one same-branch publisher.

## Repair and preserved authority

The keyed launch read still validates every row's target repository, ticket and
idempotency and must contain the preparation LRQ. Absolute status repository
paths additionally require the preparation row's absolute `target_worktree` to
match both status paths exactly. No basename, path normalization, local remote,
publisher workspace or another LRQ grants repository authority. Missing proof
reports `batch-workspace-evidence-unavailable`; conflicting proof reports the
existing `batch-launch-evidence-mismatch`. Legacy null/slug cases are retained.

The collector still requires terminal successful/publication-blocked preparation,
a valid complete manifest, successful explicit push milestone, tested remote
head or a unique same-repository marked PR, and normal pipeline/merge settlement.
It retains the batch ID, key, original launch, lock and intent fences across
failures/restarts. Publication does not resolve findings by itself. No merge,
configuration, schema, admission or terminal-PR authority changed. Existing
terminal and duplicate-publication regressions remain part of validation.

## Separate artifact failure qualification

`invalid-dropped-reason` is a vocabulary/justification rejection, not proof that
a finding is stale. `invalid-finding-outcome` covers invalid or duplicate/foreign
IDs, unsupported outcomes and blank/missing reasons; it is not proof of repair.
An earlier worker's nonconforming output authorizes neither conversion to a drop
nor rewriting results. Regression cases retain the original artifact bytes,
null outcomes and unresolved batch on each rejection. No safe automatic
historical conversion has been demonstrated.

The [runbook](../follow-up-runbook.md#findings-batch-publication-custody-findingsbatchcustody-01)
requires original artifact hashes, immutable manifest coverage, exact owner and
launch receipts, live branch/PR evidence and fresh per-item owner adjudication.
Missing worktree evidence or failed/ambiguous publisher custody requires the
runtime owner to reconcile the existing LRQ/intent and propose a separately
reviewed batch-scoped repair. No reset, mass redispatch, backfill, manufactured
outcomes, restart or live artifact rewrite is authorized by this source fix.

## Rollout and closure gates

Worker validation on November 2 passed the focused findings suite (103 tests),
ESLint (zero errors; 153 warnings), contract typechecking, the byte-stable
research walkthrough, fixture-generator Ruff checks and JSON/YAML parsing.
The required full `npm test` invocation through `worker_validation` did not
return a suite result after its configured 900-second bound. The worker
interrupted its confirmed wrapper, which exited 130 with `KeyboardInterrupt`
in `process_group_runner` / `subprocess.communicate`. That is an incomplete
validation gate, not a test pass or an established baseline failure. Publication
must wait for a bounded full-suite result; no bypass or partial PR is authorized.

1. Ordinary adversarial review and CI on the published head must settle before
   merge. No self approval or administrative merge.
2. Normal deployment owner records the deployed SHA and actual running build;
   source merge alone proves neither. This worker changes no host process.
3. Runtime owner selects one already-owned batch, verifies preparation
   `target_worktree` availability and all custody evidence, then records its next
   organic hourly collection result. There is no batch-scoped CLI collector in
   this change; `resolutionOnly` scans all unresolved batches and is unsuitable
   as a one-batch recovery shortcut.
4. Historical invalid artifacts remain unresolved pending evidence-backed owner
   decisions and separately authorized supported repair. Record actual counts,
   age and error distributions; do not equate offline success with draining the
   reported backlog.
