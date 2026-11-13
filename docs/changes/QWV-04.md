# QWV-04: one closer-outcome store, and the reviews.db residue export

## Summary

Two stores answered "did the closer land?" and they disagreed. Over the QWV-01
30-day join, `reviewer_passes` recorded 0 completed out of 634 closer passes,
while the `data/ama-closer-outcomes` lease-terminal rows recorded 81 `succeeded`
launches, all 81 of them merged. The operator chose the journal as the single
authority (decision of 2026-11-13).

## Interface changes

- `src/ama/closer-pass-projection.mjs` (new) is the only code that decides a
  closer pass's `reviewer_passes.status`, and it reads the decision from the
  journal. The mapping:
  - any `succeeded` → `completed`;
  - `superseded`, `deferred`, `pr-merged-externally`, `retryable-*` or no
    lease-terminal row → `cancelled`;
  - any other refusal → `failed`.

  The row is projected when it is recorded, again on a later reconcile of the
  same launch, and again after every lease-terminal journal append (with a
  short busy timeout, because the append can run under the lease lock).
  `metadata_json.closerOutcome` replaces `metadata_json.merged`. Token
  recording is unchanged.
- Deleted from `src/ama/dispatch-closer.mjs`:
  - `closerReviewerPassStatusForDispatchStatus`;
  - the `merged` argument at all six pass-record call sites.
- `summarizeHammerEfficiency` counts merges as `status = 'completed'`.
- `bin/closer-outcome-status.mjs [--since 30d] [--apply]` (new) prints the
  authority's `{source, launches, completed, failed, cancelled}` and the closer
  rows that disagree with it. It is read-only unless `--apply` is given, which
  re-projects pre-QWV-04 history.
- `bin/ar-residue-export.mjs` with `src/ar-residue.mjs` (new) is a dry run by
  default. `--execute` exports the stamped `operator_*` hand-repair tables to
  CSV under `$HQ_ROOT/archive/ar-residue/<UTC date>/` with a manifest (row
  count, sha256, `CREATE` sql), copies the `data/follow-export HAM_RUN_DIR=`
  fossil, and verifies by re-reading. `--execute --drop` re-verifies the
  export against the live store, then drops the tables and removes the
  zero-byte legacy DB files and the fossil directory. It refuses:
  - non-`operator_*` and unstamped tables, including the live
    `operator_hold_releases`;
  - a drop without a verified, unchanged export;
  - a non-empty DB file.

  See [AR residue archive](../data-model/ar-residue-archive.md).

## Not changed

The closer-pass attempt keying (`closer-pass-attempt.mjs`, CLOSERREUSE-01) is
unchanged, because removing it would bring back the terminal-row reuse throw.
Lease writes, closure, merge predicates, paging and the journal schema are
unchanged. No check, gate or config key is added. Running the export or the
`--apply` re-projection on the host is the operator step QWV-15.
