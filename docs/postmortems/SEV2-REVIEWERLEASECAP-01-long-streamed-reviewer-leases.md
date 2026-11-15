# SEV2: streamed reviewer leases could retain claims for most of a day

Date: 2026-11-14. Ticket: REVIEWERLEASECAP-01.
Status: report-only under the ticket's Phase 0 stop condition. No runtime
policy, configuration, live store, reviewer or daemon was changed.

## Impact and evidence limits

The supplied two-day incident summary reports 14 Claude reviews with stored
`reviewer_timeout_ms` values of 689–1,030 minutes (mean about 823), versus
189 Gemini reviews at 36–360 minutes. It also reports a Claude claim starting
at 21:32 UTC on November 14 and expiring around 11:38 UTC the following day,
with roughly an hour without API activity during a throttle wait.

These are reported observations, not independently queried measurements.
Individual stored rows, historical configuration, environment and contemporaneous
CPU/load samples were not supplied. The prohibition on touching the live review
database was preserved. Exact historical attribution therefore remains unproven;
the reproduction below establishes a sufficient production code path, not the
specific inputs used by each incident row.

## Source finding

The 20-minute legacy nominal is not the Claude claim nominal.
`src/pollonce-phases.mjs` selects `usesStreamedReviewerCeiling` for Claude,
Codex and GPT models, and calls `resolveReviewerCeilingSeconds` with
`changedLines: Number.MAX_SAFE_INTEGER` before persisting the timeout and
computed lease expiry in the claim. This saturates the diff-sized nominal
at `reviewer.ceiling_max_seconds`, whose default is 10,800 seconds (three hours),
even for a small PR. The Gemini branch uses its separate process budget.

`src/reviewer-timeout-model.mjs` then load-scales that nominal with
`maxSeconds: Infinity`. The default multiplier cap is six, so this path can
produce an 18-hour claim. With full CPU corroboration, a multiplier of 14/3
produces exactly 14 hours. The reported range requires multipliers of about
3.83–5.72, within that default curve. Lower CPU corroboration changes the
load needed to reach those multipliers. Configured multiplier caps may reach
20; Infinity removes the absolute policy cap, although the platform timer
limit still applies.

The cli-direct adapter also takes the larger of the incoming timeout and the
same saturated streamed ceiling. The inner Claude harness uses the actual diff
size and effort. The token-handoff floor only controls credential admission;
it does not assign the persisted reviewer timeout. No quota extension is
needed to explain a 14-hour lease.

## Why this PR is report-only

This behavior is intentional in the source history and documented:

- Commit `f7eabd1f6606f7a17241912eab77c7fc1a2b6649` (LOADAR-01,
  PR #1434) explicitly changed both streamed idle and ceiling resolvers to
  load scaling with an infinite policy cap.
- `docs/SPEC-adversarial-review-auto-remediation.md`, in its reviewer timeout
  description, specifies the scaled hard deadline, default ceiling settings,
  stream heartbeat evidence and quiet posting/fallback phases.
- `test/reviewer-timeout.test.mjs`, test “live reviewer survives idle, ceiling
  and silent posting windows”, explicitly preserves the live owner despite
  stale heartbeat evidence.

The ticket directs a report-only PR when the long lease is intentional and
documented. This finding satisfies that condition; it does not establish that
the operational outcome is desirable.

## Why an idle reviewer can retain ownership

The inner model subprocess has a stream idle watchdog, but it does not cover
all preparation, posting, throttle or fallback work. The cli-direct wrapper
disables its outer no-output watchdog. `src/reviewer-pass-reaper.mjs` skips
sessions still owned by the current watcher's in-flight registry and preserves
an identity-verified live process group regardless of stale model heartbeats.
A heartbeat records stream progress; its absence alone cannot distinguish a
stuck process from a legitimate API wait in those other phases.

Consequently, shortening the idle resolver alone would not provide the requested
whole-review reclaim bound. Releasing a claim while its original process can
still post would also create duplicate owners. Existing session/head fences,
posted-artifact recovery, authoritative terminal state and recovery budgets must
remain intact in any repair. This is consistent with the supplied hardening
history concerning existing progressing owners and readable ownership evidence.

## Recommendation and remaining proof

Adopt an explicit absolute ceiling after load scaling, using the existing
`reviewer.ceiling_max_seconds` setting as the hard maximum if that policy is
approved. Apply the same bound at claim, adapter, inner harness and reattach
sites; do not scale an already effective deadline again. Bound legacy and idle
resolvers too, while preserving documented configuration semantics.

For whole-review no-progress reclaim, first provide evidence covering API calls,
model output and stream events across all phases, with a bounded wait receipt
where applicable. On verified expiry, terminate and confirm the original
session's process group has stopped before releasing through the existing
session-fenced retry path. Unknown identity or failed evidence reads must remain
unknown and identify the missing evidence. Preserve legitimate progressing
owners and merged/closed terminal transitions.

Before claiming exact incident attribution, obtain an operator-provided sanitized
export of the individual rows, deployed build, resolved configuration/environment,
and claim-time load/CPU samples. Do not infer those inputs from the lease duration
alone. No new configuration keys, CI checks, gates or labels are proposed here.
The two memory searches were available and returned no matching records.

## Verification

`test/reviewerleasecap-01.test.mjs` uses temporary fixture configuration and
synthetic host readings to exercise the real streamed resolver and lease-expiry
functions. It reproduces a 14-hour lease and the 18-hour default maximum without
waiting, network access or a live database. These diagnostic tests describe the
current policy and should change with a future repair. Both tests passed under
the required netguard environment and a 600-second process-group bound through
`cwp_dispatch.worker_validation`; ESLint passed on the added file. Only the
added test file was executed, per the ticket's validation constraint.
