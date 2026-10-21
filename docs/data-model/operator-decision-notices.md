# Data Model - Operator Decision Notices

**Owner:** watcher operator-decision notification observation
**Store:** `<runtime rootDir>/data/operator-decision-notices/*.json`
**Source of truth:** `src/operator-decision-notice.mjs`
**Runtime surface:** `src/pollonce-phases.mjs`, `src/ama-closure-orchestration.mjs`

## Identity and fields

Each file is named by the SHA-256 hex digest of `repo#prNumber`. Atomic writes
retain one current observation and one latest closer outcome per PR. Missing,
unreadable, or unparseable files are treated as empty observation state.

| Field | Shape | Contract |
|---|---|---|
| `observation` | object or null | Current held head and the beginning of its backstop window; cleared when the PR is terminal or the projected decision no longer requires an operator. |
| `observation.headSha` | string | A different observed head replaces the observation and starts a fresh window. |
| `observation.startedAt` | number | Epoch milliseconds at first operator-required observation; legacy fallback when `idleSince` is absent. |
| `observation.idleSince` | optional number or null | Beginning of the current idle interval in epoch milliseconds. Null while ownership or re-dispatch is active; the next idle poll starts a fresh load-scaled backstop. Legacy idle observations use `startedAt` until activity resets the window. |
| `closer` | object | Latest recorded closer result, independent of the observation. |
| `closer.headSha` | string | Pins the closer result to the head; other heads cannot inherit its outcome. |
| `closer.result` | object or null | Observation of the closure orchestrator result, including `needsOperator`, `closureOwner`, dispatch, recovery, and retry evidence. Does not grant merge or dispatch authority. |
| `heldHeads` | object | Map of head SHA to `true`, suppressing repeated held-notice log lines. |

## Delivery contract

The watcher reads notice state asynchronously on non-alerting settled-subject
polls. Clearing an earlier observation re-reads and writes the latest state
synchronously so a closer outcome arriving during the async lookup is retained.
Operator-required observation and closer outcome persistence use synchronous
reads and writes. Closer leases and dispatch records,
follow-up jobs, and handoff review state remain their own sources of authority;
the notice store only observes them. Active ownership holds delivery even after
the backstop expires. Launch observation scans every dispatch head for the PR
and uses the shared `launchRequestInFlight` predicate, including retry descendants.
Requested, admitted, leased and running launches hold delivery regardless of age;
an unreadable retry chain cannot retire ownership. A replacement being admitted
or a queued re-dispatch also holds delivery and resets the idle interval.
Unreadable, concurrently removed, or unparseable dispatch files are skipped
individually; remaining readable records still participate in observation.

With no active ownership, `needsOperator` or owner `page` selects `no-route`;
recorded retry/lifetime/target suppression or exhausted dispatch retries selects
`retry-cap`. A recorded non-retryable hammer outcome without an available closer
route selects `non-retryable: <outcome>`. Worker exit status alone is insufficient.
Series suppression matches the review row's reviewed SHA, then the current-head
dispatch's reviewed SHA, then the newest cross-head dispatch with a reviewed SHA
(by `lastAttemptedAt`, falling back to `dispatchedAt`). Without that evidence it
matches only the observed head, never an arbitrary earlier series. Lifetime,
target-head, corrupt-ledger and explicit closer cap evidence retain their scope.
Retryable outcomes and available hammer routes remain held until the idle
backstop: nominally 45 minutes, scaled by `loadAwareTimeoutMs` using existing load
policy, without the command-timeout helper's default one-hour clamp. The page
text and payload both name the reason; an idle expiry uses `backstop`.

PR closure and review completion are distinct: the GitHub subject adapter sets
`terminal` only for a non-open PR. Delivery additionally verifies live open PR
state and the same `headRefOid`, and re-checks the per-head alert marker after
asynchronous lookups immediately before enqueue. Successful durable enqueue sets
the existing per-head debounce fields in [cascade state](cascade-state.md); failed enqueue
leaves them unset and retries later. See the
[operator notice runbook](../follow-up-runbook.md#operator-decision-notices-reviewnotice-01).
