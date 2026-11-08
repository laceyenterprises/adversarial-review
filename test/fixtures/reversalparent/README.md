# LAC-2134 refusal projections

Captured 2026-11-08. These fixtures retain the affected path's primary/final
patches, authorization and original authorization, cited review, identity
fields and durable verified-region set. Agent OS #10329 also retains the
README path that fails whole-parent equivalence.

They are **path projections**, not complete production merge evidence. File
lists in primary/final, HAM commit, parent and reviewed snapshots are filtered
to those paths; completeness flags are false and unrelated metadata is omitted.
No projected fixture is written
to the runtime evidence store. Positive authorization is tested separately
with synthetic complete fixtures.

The #10329 evidence was collected through read-only GitHub REST reads. The
#10301 and Finch evidence includes captured daemon history and durable
observations; primary/final affected-path changed content, current/original HAM
commit patches and messages, identities, review bodies and head check runs were
independently read from GitHub. Durable region sets are
historical daemon observations, not GitHub authorizations. Original citations
are still re-evaluated.

See [the investigation](../../../docs/investigations/LAC-2134.md) for immutable
review/commit references, reproduction endpoints, separate dispositions and
the distinction between a mapping defect and missing authorization.
