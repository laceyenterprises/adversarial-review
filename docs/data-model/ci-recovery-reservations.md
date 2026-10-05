# Data Model - CI Recovery Reservations

**Owner:** adversarial-review watcher CI recovery
**Store:** `<watcher rootDir>/dispatch/ci-recovery/`
**Source of truth:** `src/ci-recovery.mjs`
**Runtime surface:** `src/reviewer-ci-admission.mjs`, `src/daemon-clean-merge.mjs`, `src/follow-up-merge-agent.mjs`, `src/reviewer-timeout-exhausted-dispatch.mjs`

## Identity and records

Each filename is the SHA-256 hex digest of an identity string followed by
`.json`. Exclusive creation (`wx`, mode `0600`) serializes callers and preserves
budgets across process restarts. All callers must supply the same watcher
`rootDir`; `HQ_ROOT` is only the managed attestation root, never a budget root.
Without a watcher root, recovery and paging do nothing.

| Identity | Fields | Contract |
|---|---|---|
| `rerun:<lowercase repo>:<headSha>:<trimmed lowercase check>` | `runId`, `attempt`, `headSha`, `check`, `requestedAt` | Records the first observed cancelled run/attempt for a check/head. This observation alone does not consume the POST budget. |
| `workflow-rerun:<lowercase repo>:<headSha>:<runId>` | `runId`, `attempt`, `state` | Deduplicates cancelled checks in one workflow. `reserved` holds an in-flight request; `posted` means the POST succeeded. |
| `page:<lowercase repo>:<prNumber>:<headSha>:<dedupeKey>` | `reason`, `state` | `reserved` holds delivery; `posted` means the shared operator-decision alert path accepted delivery. |

A rejected POST or alert delivery removes its exclusive action reservation.
A later tick re-reads the PR head and workflow before retrying. Read calls use
bounded GitHub retries; POST is attempted once per tick, because its response
may be lost after GitHub accepts it. A queued/in-progress run prevents a second
POST. A higher attempt or different workflow run for an existing check/head
pages once instead of requesting another rerun.

Successful state updates use a sibling `.json.posted` temporary file and atomic
rename. If persistence fails after an accepted action, the original reservation
remains held. Legacy records with no `state` remain consumed for compatibility.
A crash while an action is reserved has ambiguous delivery; there is no automatic
expiry that could duplicate a successful request. Operators must inspect GitHub
or alert delivery before removing such a reservation.

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
repository and managed-attestation evidence. Hosting trust resolves through
`ci.hosting.mode`, including config-file values and their environment alias.
