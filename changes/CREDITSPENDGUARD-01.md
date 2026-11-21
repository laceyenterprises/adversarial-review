# CREDITSPENDGUARD-01 — an exhausted Codex plan is never selected; reviewer quota fails closed for spend

A subscription account keeps serving turns after its plan window is used up
when it holds purchased credits. Routing must not treat that as capacity.

- `codexPlanLimitExhausted` (`src/fleet-quota-status.mjs`) is the one plan
  predicate: a current Codex plan row is exhausted at 100% used or above, or
  when the provider reports `limitReached: true`, until its advertised reset.
  `credits` never changes the answer. The shared classifier projects such an
  account as `exhausted` with `stateSource: codex-plan-meter`. That covers
  reviewer account selection, closer and remediator Codex lanes, and every
  other consumer of the classification.
- `readReviewerQuotaDecision` no longer fails open on a quota-probe error for
  providers whose subscription accounts can bill credits or extra usage
  (`openai`, `anthropic`). It returns `capped` with state `probe-error` and
  `quotaReason: quota-unverifiable-credit-capable`. The reviewer spawn records a
  transient quota skip, and the route falls back as it does for a capped
  primary. A probe error never records a corporate Codex quota cooldown. Other
  providers keep the documented fail-open.

Stale-evidence semantics are unchanged: stale rows still cannot synthesize
exhaustion, and an account still needs fresh, measured evidence to be selected.

Synthetic offline fixtures in `test/credit-spend-guard.test.mjs` cover the
predicate, limit-reached plans with credits for reviewer, closer and
remediator selection, probe-error holds, and an unaffected available account.
The two reviewer tests that asserted fail-open on an unreadable quota now
assert the hold. No configuration, persistent store shape, lifecycle state or
smoke promise changes.
