# DF-01 duplicate PR evaluation

Compared on 2026-06-03:

- PR #221 (`codex-df-01-r2/DF-01`): 8.3/10 after remediation
- PR #222 (`codex-df-01-r3/DF-01`): 6.5/10
- PR #223 (`codex-df-01/DF-01`): 6.9/10

I selected PR #221 for final remediation and merge.

This note is intentionally committed at the module root as the durable
operator-requested duplicate-PR evaluation artifact for this sweep.

PR #221 is the strongest branch because it implements workspace reaping in the
current `follow-up-jobs` module, covers completed/failed/stopped terminal jobs,
handles stopped-archive lookups, isolates per-workspace failures, preserves
counters for operator visibility, and already had a meaningful test/runbook
surface before this final pass. This remediation adds explicit duplicate
timestamp ordering, missing-timestamp sample paths, permission-denied diagnostics,
and persisted daemon sweep state.

PR #222 carries the same general idea through the older
`follow-up-remediation` surface and leaves more behavioral risk around archive
ordering, deletion guarding, hard-coded cadence, and skip observability. PR #223
is closer to the selected module shape than #222, but it is thinner: it lacks the
prior remediation hardening and leaves more edge cases for terminal lookup,
unreadable records, and archive interaction. Given the duplicate set, #221 has
the best code shape and the lowest remaining operational risk.
