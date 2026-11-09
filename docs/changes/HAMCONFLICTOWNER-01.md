# HAMCONFLICTOWNER-01

## Summary

A closer that cannot prove its conflict replay hands the current PR head to
the existing follow-up remediation queue. The watcher consumes the terminal
audit before closer cap/retry selection, and keeps one durable remediation
owner per head. The work order resolves conflicts against the current base,
preserves both sides, addresses open review findings and pushes a new head
for normal full review with full-range validation.

## Interface changes

Follow-up jobs optionally retain `closureHandoff` with `reason`, `headSha`,
`review: "full"` and host-captured untrusted `reviewContext`. The job's existing
PR identity, `revisionRef`, `jobId` and status form the ownership receipt.
Shared next-action snapshots carry this handoff and select `remediate` /
`remediator` for a matching pending job through admission delays. Existing
builder-tag and account routing, live custody, queue claim and merge gates
remain authoritative. Handoff read/enqueue failures retain the stop for a
later watcher pass.

The existing cross-process claim keys this work by PR/head/reason, including
archived jobs and changes to work-order wording. A read-only receipt lookup
preserves an enqueued owner through later GitHub outages. Published conflict
remediation retains normal review intent even on the last allowed round;
it cannot use the suppressed final-push shortcut.

Only `conflict-primary-unproven` takes this route. Timeout retry and proven
replay publication remain unchanged, and unproven replays still cannot publish.
No config key, queue status, CI check, label or live activation is added.

The private rescue reader should consume the returned `closureOwner`
(`action: "remediate"`, `actor: "remediator"`,
`reason: "conflict-primary-unproven"`) and `remediation.jobId`, or project
the matching job's `closureHandoff` into `remediation.job` in the shared
next-action snapshot. It must retain that pending owner instead of dispatching
another closer. No private repository is changed here.

## Verification

Synthetic fixtures exercise terminal audit consumption, actual queue admission,
same-head deduplication including terminal/archived jobs, normal full-review
work orders, delayed pending ownership, moved/closed heads, unavailable
provenance, unchanged timeout retry and unchanged successful replay behavior.
The orchestration regression proves exhausted closer attempts cannot prevent
the builder handoff or select another closer.

- `npm run lint`: passed with zero errors (existing warnings only).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed, with three
  byte-stable transcript deliveries.
- Netguard-prefixed `node --test --test-concurrency=2 --import
  ./test/helpers/rate-limit-state-isolation.mjs <files>` exercised all 162
  files selected with `git grep -l` for the edited modules and prompt. After
  corrections, the ten affected/core suites passed all 520 tests, including
  the watcher claim loop. The final meter/handoff/state-machine run passed
  another 145 tests across five suites.
- The monolithic `npm test` invocation reached the existing 900-second limit.
  The complete 809-file suite then passed in four sequential, bounded
  `npm test -- <files>` invocations through the same sandbox runner, with
  Netguard enabled: 19,071 passed, 11 skipped, zero failures or cancellations.
  No test runner, timeout, CI job or publication gate was changed.
