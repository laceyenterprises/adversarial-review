# SEV1 — a daemon fail-closed routed to a hammer that declines clean heads leaves green PRs without an actor

Date: 2026-10-31. Ticket: FAILCLOSEDHAMMER-01. Severity: SEV1 (operator rule:
a green PR with no actor is SEV1).
Status: source correction and offline regression coverage. The fix takes effect
with the normal review-service deploy. Live receipt (SRE): the next
daemon-failed-closed clean PR merges by hammer within one closer pass.

scars: merge.finding-remediation-and-authoritative-terminal

That contract requires every PR to reach an authoritative terminal outcome
through a named owner. Its first recorded failure mode, "two contracts in the
review service contradict each other", is this incident: the daemon's identity
gate and the hammer's clean-head rule each handed the PR to the other. No
unsafe merge happened. The failure was a clean, approved PR that could not land.

## Impact

One approved, green pull request with a CLEAN merge state and no findings did
not merge. A read-only rescue evaluation reported it as `merge`. The watcher
handled it on every pass and nothing changed. Each component reported a normal,
non-terminal outcome, so nothing in the closure path escalated it.

## What happened (generic)

On each watcher pass:

1. The shared next action selected the daemon (`R15-daemon`,
   `clean-exact-head`). The daemon clean-merge failed closed with
   `worker-identity-unresolved`: the PR had no `pr_opened` build-completion
   identity.
2. The decline was folded into the shared decision. Next-action mapped a
   non-transient identity decline to an R05 `safety-refusal` with actor
   `closure-recovery`. Its recovery deadline lapsed and the watcher logged
   `next-action deadline expired … action=hammer actor=closure-recovery
   reason=safety-refusal … route=daemon-failed-closed`.
3. Nothing executes an R05 `safety-refusal`. The closure-recovery executor
   only handles R04 ownership reconciliation, and the recovery-expiry rule
   promotes only `lease-expired` and `merge-receipt-unconfirmed`.
4. The hammer wake fired from the pass's initial decision, which named the
   daemon (`clean-exact-head`). A closer that resolved the next action afresh,
   without the daemon's same-pass refusal, saw the same daemon decision and
   declined the head as the daemon's job. The audit showed `clean-exact-head`
   and `not-attempted`.

The next pass started again from a fresh snapshot without the refusal, so the
daemon was selected again. The loop never ended.

## Root cause

The earlier design "two autonomous-close lanes for daemon-fail-closed clean
PRs" (PR 667) routed remediable daemon fail-closes (CI, conflict, moved head)
to the capped hammer. It deliberately excluded `worker-identity-unresolved`,
treating the hammer as a "blind merge-clicker" for un-attributed PRs. The
operator-approval lane covers un-attributed PRs only when someone applies a
label. Attributed worker PRs whose identity row was missing fell between the
two lanes.

The exclusion rested on a false premise. The hammer does not need the daemon's
build identity: it merges under its own merge lease and terminal audit, and
re-proves exact head, required checks, findings and strict-mode rules itself.
Build identity is the daemon's accountability for an inline merge. The hammer's
own lease and audit already provide that accountability.

The second cause was routing that depended on in-pass evidence. The daemon's
refusal lived only in the pass's next-action generation. Any actor that
re-derived the decision got the daemon back, and the daemon refused again.

## Why nothing caught it

- Each of the three outcomes was correct on its own terms: the daemon's
  identity gate, the R05 refusal mapping and the closer's ownership check.
  The tests pinned each one separately. A test even asserted the exclusion
  ("identity is NOT hammer-remediable → parks").
- No test followed a non-transient identity decline into its next owner, so
  nothing showed that no executor existed.
- The snapshot-refresh no-progress counter covers only `snapshot-refresh`
  decisions. An R05 refusal is not one, so the PR never aged into a page.

## Source correction

- `src/pr-next-action.mjs`: a non-transient `worker-identity-unresolved`
  decline on a clean, exact-head, green, MERGEABLE head (attestation not
  unknown or invalid) now selects `R15-daemon-failed-closed`
  (hammer / hammer / `daemon-failed-closed`, dispatch intent). This row sits
  ahead of both daemon rows, so the daemon is not reselected in that pass.
  Earlier rows keep precedence: live owners, holds, caps, stops, other safety
  refusals, and CI and conflict repair. On any head that is not merge-ready,
  the decline is still an R05 refusal and never licenses CI, conflict or
  findings repair around identity.
- `src/ama-closure-orchestration.mjs`: the existing fail-closed hammer
  fallback admits the hand-off. The closer receives the selected pair, which
  carries the daemon refusal, so the hammer launches instead of declining the
  head. If the hammer refuses the hand-off, closure returns the terminal named
  reason `daemon-failed-closed-hammer-refused` with `needsOperator` and records
  it as the park reason. It pages once per head through closure-wait. A
  refusal here is the closer's own merge-eligibility refusal, or a fresh
  decision that hands the head back to the daemon. The PR therefore escalates
  once and does not ping-pong between daemon and hammer. Launches, waits,
  drain, capacity and outcomes that already escalated (caps) keep their own
  owners.
- Safety conditions are unchanged: exact head, required checks green, no
  blocking findings, strict-mode non-blocking rules, the per-PR hammer retry
  cap and lifetime ceiling, the merge lease, and no `--admin`. The hammer path
  never requests a re-review. A hammer that stops without merging falls under
  the existing hammer-stop hold and its one page per head.

The identity gap itself (the build-pack bump path not recording a
`pr_opened` identity) is fixed separately. This ticket fixes the routing, so a
future identity gap cannot leave a green PR without an actor.

## Regression coverage (synthetic)

`test/failclosedhammer-01.test.mjs`, `test/pr-next-action.test.mjs`,
`test/daemon-next-action.test.mjs`, `test/watcher-daemon-clean-merge.test.mjs`:

- A clean, green exact head with `daemon-failed-closed` routing: the real
  closer launches one hammer with the terminal-audit contract and no
  `--admin`. Without the daemon refusal, the same closer reproduces the
  decline (`clean-exact-head`, no launch).
- The same decline with a blocking finding, strict non-blocking finding, red or
  pending checks, a conflict, a stale reviewed head or an invalid attestation
  is not a hammer close and not a daemon merge. Blocking findings without a
  daemon attempt still go to remediation.
- A non-identity hammer refusal (merge-eligibility refusal, or a hand-back to
  the daemon) produces `daemon-failed-closed-hammer-refused`: one page per head
  across two passes, recorded as the park reason.
- A hammer launch, an already-escalated cap and a drain deferral keep their
  own owners.
- A live hammer and a final hammer no-merge on the head outrank the hand-off.

Tests A/B against the base tree fail before the fix and pass after it.

## Follow-ups

- The SRE live receipt above.
- `HAMMER_CLOSABLE_DAEMON_FAILURES` in `src/pr-next-action.mjs` lists the
  daemon-only accountability declines the hammer can close. Add a reason there
  only if the daemon alone requires it; gate-fact declines keep their own rows.
