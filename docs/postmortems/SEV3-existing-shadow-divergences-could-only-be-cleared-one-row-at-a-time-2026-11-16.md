# SEV3: Existing shadow divergences could only be cleared one row at a time

The historical shadow backlog grew to roughly six thousand open divergences.
Reviewed exact patterns applied only during append, so adding a pattern could
not clear existing evidence. Promotion correctly counted all retained open rows;
manual individual overrides were the only historical resolution mechanism.

`shadow-pattern apply-existing` now previews eligible rows read-only, then writes
individual audited overrides in bounded transactions. Each retains the reviewed
pattern and the applier. Revocation atomically reopens current overrides from
that pattern while preserving the complete override and revocation; superseding
a revoked override retains the prior record. Human replacements and append-time
captures survive revocation. Promotion arithmetic is unchanged.

Synthetic SQLite tests cover eligibility, interruption, reruns, atomic rollback,
reversal and batch boundaries. Fold errors and unkeyable rows remain individual
triage; bulk application cannot resolve them.
