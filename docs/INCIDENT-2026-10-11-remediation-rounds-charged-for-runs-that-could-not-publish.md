# Remediation rounds charged for runs that could not publish — 2026-10-11

Operator direction: "On launch all fixes".

PR 8044 exhausted its medium-risk two-round budget even though one Codex run
fixed four findings and could not push because a pre-push check could not run
in its sandbox. PR 8052 spent both rounds on activation-gate push refusals for
documentation changes. PR 8050 spent rounds during a tool-host outage; the
operator manually added another round through `retrigger-remediation`.
PR 1261 refunds comparable HAMMER failures, but remediation had no equivalent.

The remediation claim increments `currentRound` before execution. A completed
worker was charged even when infrastructure prevented publishing and the PR
head never moved. Comment narratives cannot safely distinguish that failure
from an ordinary unsuccessful remediation.

REMREFUND-01 qualifies a refund only from a recorded worker outcome and an
unchanged authoritative live PR head. Recorded reasons are
`codex-tool-host-unavailable`, `publish-blocked`, `boot-failed`/`boot-failure`,
and signal exits 137 or 143. Local child exit/error events are recorded in the
job; HQ dispatch status and matching terminal events supply external outcomes.
Missing live heads and ordinary failures remain charged. No narrative text is
used to grant a refund.

The existing retry transition removes the active charged round and retains its
outcome and both heads in retry history. Each charged round receives one retry;
a second failed attempt stays charged. Across all jobs for a PR, at most two
refunds are allowed, including archived stopped jobs. The existing job-write
lock serializes eligibility and requeue. `ADV_MAX_REMEDIATION_INFRASTRUCTURE_REFUNDS`
can lower that ceiling but cannot raise it above two. No config schema changes
are required.

A Codex tool-host failure or a local harness boot failure uses the configured `roles.remediator_fallback`
chain on its retry, retaining quota eligibility and cross-model reviewer
exclusions. If no eligible fallback exists, the pending job holds rather than
spawning an excluded reviewer family. Other infrastructure outcomes retry the
configured remediator. Refunded marker comments say `not charged: <reason>`;
budget stop comments report how many rounds advanced the published PR head.

Regression coverage lives beside the follow-up remediation and PR ledger tests.
Fixtures cover unchanged/moved/unknown heads, structured outcomes, one retry per
round, the PR-wide ceiling, fallback diversity, and published-round comments.
Existing follow-up, quota-hold, HQ dispatch, and comment tests remain relevant.
All tests run offline. No CI checks, publication gates, labels, live ledger
mutations, reviewer-pool changes, or merge-authority changes are part of this fix.

Historical runs without recorded infrastructure outcomes are not inferred from
comments or retroactively refunded. A detached local child whose parent daemon
was lost before recording its exit also cannot be classified safely here;
external worker supervision must supply a recorded outcome for that case.
