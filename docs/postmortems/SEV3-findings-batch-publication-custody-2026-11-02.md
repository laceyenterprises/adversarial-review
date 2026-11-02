# SEV3: findings-batch publication rejected native workspace display paths

Contract: FINDINGSBATCHCUSTODY-01. Ticket: LAC-2143. Date: 2026-11-02.
Status: source qualification; ordinary review, exact-head CI, merge, deployment
and organic recovery remain separate gates. The backlog is not cleared.

## Impact and root cause

Canonical health reported 2,315 unresolved findings at 22:32 UTC and 2,329 at
23:21 UTC, oldest 229 hours. Errors included `batch-launch-evidence-mismatch`,
`invalid-dropped-reason` and `invalid-finding-outcome`. These totals describe the
backlog, not findings attributed entirely to this one defect.

Native `hq dispatch status` serializes a provisioned worktree into `repo` and
`workspacePath`. The consumer treated non-null `repo` only as a repository slug
or short name, rejecting the native absolute path before independently keyed
launch and remote publication evidence could establish repository custody.

The original RCA worker preserved commit
`260b0802a53b0ab5e9df094b4d9ce427bca1be09` but exited without a PR; the owner
correctly marked that launch `failed/no_work_done`, despite exit zero. Rescue
preserved the commit in an isolated worktree and found its proposed fix depended
on `target_worktree`, which the public dispatch projection intentionally omits.
The original synthetic launch fixture had selected that private field directly
from SQLite, so its passing tests did not prove the consumer contract worked.
No failed worker completion evidence was manufactured during recovery.

## Repair and qualification

Absolute native repository/workspace paths are display metadata and confer no
repository identity. The consumer accepts that wire shape while retaining the
exact preparation LRQ and every keyed row's repository, ticket and idempotency
checks. Successful/publication-blocked terminal preparation, complete manifest,
explicit successful push evidence where present, independent remote tested
head or unique same-repository marked PR, and normal pipeline/merge settlement
remain required. Foreign slugs, foreign keyed identities and bad remote evidence
still refuse publication. No path basename or private workspace field grants
repository authority. No public API scope, schema or permission changed.

The fixture generator now uses native public ledger models and worker APIs
against disposable SQLite, `resolve_status`, and the actual SDK producer view
`fetch_app_dispatch_reads`. The generated public launch fixture omits worktree
paths exactly as production does. All terminal/push states and identities are
explicitly synthetic. See the [fixture provenance](../../test/fixtures/findings-custody/README.md).

Validation includes the actual public projection, successful single-publisher
recovery, relocated display paths, negative repository/LRQ/ticket/key/remote
cases, restart and duplicate fences, and byte-preserving invalid artifacts.
Hosted full Node 22/26 suites must complete on the published head before merge.
The earlier worker's full local sweep did not return within its 900-second
wrapper bound; this is incomplete coverage, not a passing suite or a demonstrated
baseline failure. Rescue publication obtains the required hosted matrix and
ordinary cross-model review; publication itself grants no merge authority.

## Historical artifacts and runtime closure

Invalid dropped reasons do not prove a finding is stale. Invalid outcomes or
missing/duplicate/foreign IDs do not prove repair. The collector retains original
artifact bytes, null outcomes and unresolved batch custody on those failures.
No safe automatic conversion to a drop or applied outcome is established.

The [bounded runbook](../follow-up-runbook.md#findings-batch-publication-custody-findingsbatchcustody-01)
requires original hashes, exact public launch custody, original branch and remote
PR/head evidence, and fresh per-item owner decisions. Failed or ambiguous
publisher intent stays fenced; there is no mass redispatch, intent reset, raw
store edit, whole-backlog drain or manufactured outcome in this fix.

After ordinary merge and normal native deployment, the runtime owner records the
actual loaded build and observes the next organic hourly collection of one
already-owned batch. Source merge and offline fixtures establish neither that
receipt nor backlog clearance. Historical invalid artifacts require a separately
reviewed, batch-scoped owner repair with original evidence retained.
