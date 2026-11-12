# CLOSERHEADPIN-01

## Summary

A closer whose PR head moved before it booted no longer stands down on a head
its own lease claimed, and the stand-down is no longer reported as success.

- **One owned head.** When the PR head moves off a live closer lease whose
  launch has not booted (`requested`/`admitted`), the watcher no longer
  carries the lease to the new head. It ends that launch through the
  DAEMONSUPERSEDE-01 cancel executor with the typed reason
  `superseded-head-moved` (marker `supersededByHeadMove` on the dispatch
  record) and settles the lease `terminal`/`superseded-head-moved` on the
  pinned head. The outcome is reclaimable, so closure re-arms at the new head
  through its own review. Booted, unreadable or unconfirmed launches keep the
  CLR-01 rekey.
- **The stop reason survives.** A launch's own world refusal (for example
  `head-changed`) recorded at any head now wins over a later generic closer
  stop from the same launch. `recordHammerEarlyFailure` returns the earlier
  refusal instead of appending a `stop-reason-unregistered` deferral at the
  pinned head, and the lease reconciler settles `superseded-head-moved`
  instead of `retryable-stop-reason-unregistered`.
- **No false success.** Because the stand-down now leaves only its
  `failed-without-merge` refusal (or a confirmed cancel), HQ's
  `terminal-audit` contract no longer reads a deferred attempt as success.

Option (b) from the ticket was chosen: under MSM, hammer heads are not
re-reviewed, so a hammer adopting a foreign, unreviewed head (option a) would
merge commits no reviewer saw.

## Interface changes

- New closer-lease terminal outcome `superseded-head-moved` (valid and
  reclaimable).
- New export `supersedeHeadMovedCloser` in `src/ama/closer-supersede.mjs`;
  `supersedeNotBootedCloser` keeps its behaviour and now shares the executor.
- New leaf module `src/ama/closer-head-pin.mjs` (`readLaunchWorldRefusal`,
  `worldRefusalLeaseOutcome`).
- Optional dispatch-record field `supersededByHeadMove`.
- `resolveMergeAgentCoexistenceForWatcher` accepts an injectable
  `supersedeHeadMovedCloserImpl`.

## Verification

Run with `ADVERSARIAL_REVIEW_TEST_TEMP_BASE=/tmp` under the netguard
environment, one file at a time:

- `node --test test/closerheadpin-01.test.mjs`: 7 pass. Against the base
  versions of `hammer-terminal-audit.mjs`, `dispatch-closer.mjs` and
  `closer-lease.mjs`, 4 fail.
- `test/daemonsupersede-01.test.mjs` 15 pass. Its head-mismatch case now asserts
  the typed head-moved cancel, never the clean-review supersede.
- `closer-lease-rekey` 19, `ama-closer-terminal-cancel` 20,
  `verifyheadtransient-01` 135, `inconclusiveretry-01b` 14, `closergates-01` 13,
  `hammer-helper-step` 22, `lvr-no-op-outcomes` 20, `hamconflictowner-01` 19,
  `ama-closer-dispatch-priority` 332, `ama-hammer-background-dispatch` 148,
  `watcher-claim-loop` 169, `smv` (after refreshing the orchestration
  projection hash): all pass.
- ESLint on the changed sources and `npm run typecheck:contracts`: clean.
