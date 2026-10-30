# Data Model - CI Recovery Reservations

**Owner:** adversarial-review watcher CI recovery
**Store:** `<watcher rootDir>/data/ci-recovery/`
**Source of truth:** `src/ci-recovery.mjs`
**Runtime surface:** `src/reviewer-ci-admission.mjs`, `src/daemon-clean-merge.mjs`, `src/merge-agent-candidate.mjs` (re-exported by `src/follow-up-merge-agent.mjs`), `src/reviewer-timeout-exhausted-dispatch.mjs`, `src/ama-closure-orchestration.mjs`, `src/follow-up-remediation.mjs`

## Identity and records

Each filename is the SHA-256 hex digest of an identity string followed by
`.json`. Atomic exclusive publication (temporary file plus hard link, mode `0600`) serializes callers and preserves
budgets across process restarts. All callers must supply the same watcher
`rootDir`; `HQ_ROOT` is only the managed attestation root, never a budget root.
Without a watcher root, recovery and paging do nothing.

New records also store their complete unhashed `identity`. Repository rename
replay moves that identity and its digest filename while retaining the budget.
Older digest-only records resolve their exact historical key on access. If a
historical name has been reused by another repository ID, ambiguous legacy
evidence refuses recovery instead of combining the two repositories. See
[repository identity](repository-identities.md).

| Identity | Fields | Contract |
|---|---|---|
| `rerun:<lowercase repo>:<headSha>:<runId>:<trimmed lowercase check>` | `runId`, `attempt`, `headSha`, `check`, `requestedAt` | Records the first observed cancelled or infrastructure-failed run/attempt for a check/head. This observation alone does not consume the POST budget. |
| `workflow-rerun:<lowercase repo>:<headSha>:<runId>` | `runId`, `attempt`, `state`, `reservedAt` | Deduplicates cancelled and infrastructure-failed checks in one workflow. `reserved` holds an in-flight request; `posted` means the POST succeeded. |
| `page:<lowercase repo>:<prNumber>:<headSha>:<dedupeKey>` | `reason`, `state`, `reservedAt` | `reserved` holds delivery; `posted` means the shared operator-decision alert path accepted delivery. |

`recoverInfrastructureChecks` admits only all-zero-step failed Actions checks,
with no pending/missing contexts. It re-reads the latest jobs page and requires
every targeted job ID and head still match the recorded zero-step failure.
The ordinary workflow snapshot and open/current-head read then guard the POST.
Closure owns the request while selecting the CI observer; reviewer admission
and the remediation wait's five-minute probe use the same reservations. A
second infrastructure failure on a higher attempt pages once with
`required-checks-infrastructure-again`; it never authorizes repeated reruns or
merge. Restored billing may still need an operator rerun after this one
recovery attempt was consumed during the outage. Conflict repair takes
precedence over the infrastructure observer, subject to existing safety gates.

A rejected POST or alert delivery removes its exclusive action reservation.
A later tick re-reads the PR head and workflow before retrying. Read calls use
bounded GitHub retries; POST is attempted once per tick, because its response
may be lost after GitHub accepts it. A queued/in-progress run prevents a second
POST. A higher attempt on the same workflow run for an existing check/head
pages once instead of requesting another rerun.

Successful state updates use a sibling `.json.posted` temporary file and atomic
rename. If persistence fails after an accepted action, the original reservation
remains held. Legacy records with no `state` remain consumed for compatibility.
Reserved actions older than 60 seconds are resumable. A workflow retry requires
fresh exact-head evidence that the original attempt remains cancelled or infrastructure-failed. Queued
or higher attempts never receive a duplicate POST. Page retries use the shared
durable, debounced alert path. Exclusive minute-scoped resume claims serialize
concurrent ticks, including after interrupted recovery. Invalid legacy records
use their file modification time as the grace-period origin.

## Legacy store migration

Reservations formerly lived in `<watcher rootDir>/dispatch/ci-recovery/`.
Before reserving an identity, the watcher lazily migrates its matching legacy
`.json` file into `data/ci-recovery/`, preserving its contents and budget evidence.
Exclusive hard-link publication never replaces an existing destination
reservation; the destination wins when both stores contain the same identity.
After publication succeeds or the destination already exists, the matching
legacy file is removed. Other migration errors propagate without removing the
legacy file. Unvisited identities remain in the legacy directory until accessed;
there is no bulk startup migration. New reservations use only the gitignored
`data/` tree so runtime state does not dirty the checkout or block deployment.

## Retention and failure handling

There is no automatic garbage collection. Keep records while that PR head can
still be revisited. After the PR is terminal and its head is no longer eligible,
the operator may remove its records and leftover `.posted` files. Deleting live
records resets the budget and can permit another request. The watcher owns this
store; it must not be placed in the HQ-owned dispatch tree.

Recovery/bootstrap errors are logged by daemon and candidate callers and retain
the existing fail-closed CI classification. They never authorize a merge. The
daemon checks the autonomous execution switch before recovery POSTs or bootstrap
paging. The shared alert path owns transport retries and durable delivery.

## Bootstrap provenance

AMA audit metadata records `ciMode` as `github-checks` or `no-ci-bootstrap`.
Merge-agent dispatch records written by `src/follow-up-merge-agent.mjs` also
carry `ciMode` and `ciBootstrap` (null, or `{mode, noCi?, headSha?}`). Only a
`no-ci-bootstrap` mode bound to the exact current head can replace ordinary CI
for an otherwise eligible clean or HAM-certified merge; every attempt refreshes
repository and managed-attestation evidence. Bootstrap always requires a valid Ed25519 runner signature and a configured public key, regardless of hosting mode. Exact-head statuses and check suites must also be empty.
