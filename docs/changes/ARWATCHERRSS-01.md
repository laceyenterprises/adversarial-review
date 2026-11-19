# ARWATCHERRSS-01

## Summary

A long-running review watcher process showed three consecutive RSS rises. Phase 0
ran the real `pollOnce` and the hammer-scratch sweep ticker in-process for 2,000
polls (30 PRs, rotating heads, always-unreadable ledger stub) under a sanitized
synthetic environment. JS heap and RSS both plateau after the first ~100 polls
(heapUsed 45.9-46.5 MB and RSS 219-223 MB from poll 600 to 2,000), and heap-snapshot
diffs after warm-up show growth only in compiled code, not in any Map, Set,
array or string. Outcome (b): no unbounded structure reproduces, so no code or
test changes. The measurements, the module-level structure review and the
limits are in
`docs/postmortems/SEV3-review-watcher-memory-grows-under-steady-polling-2026-11-19.md`.

## Interface changes

None.

## Verification

- Synthetic in-process polling probe, 2,000 polls, 0 poll errors; separate
  heap-snapshot runs at 0, 500, 1,000 and 2,000 polls diffed by constructor.
  Results are tabulated in the report.
- Docs-only change: no source or test files are touched.
