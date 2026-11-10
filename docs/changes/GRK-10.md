# GRK-10 — Preserve family eligibility before reviewer fallback handoff

## Summary

The existing Grok builder route selects Codex review and `remediator-codex`.
Gemini's immediate fallback now checks normalized original builder and acting
families before transferring the durable reviewer claim. Eligibility is computed
once from the selected route snapshot and applies on cooldown entry and after
model-unavailable and quota-exhausted results; live credential admission remains
inside the fallback launch path.
Unknown, same-family and Grok acting candidates cannot receive the claim.
The primary failure and settlement budgets remain authoritative when no eligible
fallback exists.
Each Gemini invocation with a family-refused configured fallback warns once,
naming the builder, fallback model and policy refusal.

## Interface changes

No new configuration, acting lanes, merge authority or CI checks.
Closer wrappers continue to preserve the original builder family. The public
title-routing documentation now names the fallback claim boundary.

Activation belongs to GRK-16: merge and normal companion float, then watcher
reload through its registered service owner. GRK-16 must collect a real `[grok]`
toy PR's non-Grok review and remediation route receipt. No live canary runs here.

## Verification

All commands ran through bounded `cwp_dispatch.worker_validation` under netguard.

- `node --test --test-concurrency=2 test/grok-builder-routing.test.mjs test/reviewer-spawn-settle-quota.test.mjs`:
  61 passed. Includes title/closer routing, Codex outage to Claude or defer,
  remediation fallback refusal, and unchanged pi/opencode/hermes routes.
- The new handoff regression failed on the unsafe baseline. After the fix,
  18 ineligible candidates, each invoked twice across quota persistence, produced
  zero claim transfers and preserved the primary quota result in all 36 calls.
  Existing eligible Claude fallback tests still pass.
- The Grok spawn-refusal fixture now uses disposable state, satisfying the
  existing checkout-write isolation check.
- Scoped ESLint with `--fix`: zero errors; three existing unused-import warnings.
- `npm run typecheck:contracts`: passed.

The full suite and demo were not run, following this dispatch's scoped-test
requirement. CI remains the full gate.

Final comment-only remediation adds the model-unavailable variant across the
same 18 ineligible candidates, verifies exactly one settlement and operator
alert per invocation, and checks one fallback-refusal warning per invocation.
The quota variant retains its two invocations across persisted cooldown.

Final-round verification (all tests offline through `bin/run-bounded.sh`):

- `node --test --test-concurrency=2 test/grok-builder-routing.test.mjs test/reviewer-spawn-settle-quota.test.mjs`:
  62 passed.
- `node --test test/hammer-prompt-contract.test.mjs`: 5 passed. The existing
  Node 26 CI failure came from reading edit-plan examples removed from the
  prompt. The test now reads the real helper's documented `--help` output and
  executes all four plans, while handling the help command as usage output.
- `node --test test/watcher-claim-loop.test.mjs`: all 161 inner cases passed
  with a 600-second bound after the initial combined run exceeded 120 seconds.
- Scoped ESLint: zero errors, three existing unused-import warnings.
- `npm run lint`: zero errors, 152 existing warnings.
- `npm run typecheck:contracts`: passed.
