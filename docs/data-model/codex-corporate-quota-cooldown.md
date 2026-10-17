# Corporate Codex quota cooldown

Source: `src/codex-account-routing.mjs`, `src/reviewer-spawn-settle.mjs`, and
`src/pollonce-phases.mjs`.

`data/codex-corporate-quota-cooldown.json` lives under the resolved review state
directory and contains `{ "resetAt": "<ISO timestamp>" }`. A typed corporate
Codex reviewer runtime `quota-exhausted` result, or an authoritative cap from
selected-account spawn preflight, writes it atomically before reviewer capacity
is released. Other accounts and failure classes do not write it.

A future reset blocks corporate reviewer admission and permits personal only
with independent fresh quota and broker evidence. Missing, unreadable, malformed
or expired records preserve fleet-based selection. The provider reset is preferred;
absent or past resets use 15 minutes. Holds are bounded to seven days. Expired
records need no cleanup to stop applying.

This evidence cannot grant seats or bypass cross-model review, current-head
deduplication, freshness checks, or the single-claim CAS. Account attribution on
the claimed review remains the account used for quota preflight and token renewal.
