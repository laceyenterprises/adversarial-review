# GRK-10 — Preserve family eligibility before reviewer fallback handoff

## Summary

The existing Grok builder route selects Codex review and `remediator-codex`.
Gemini's immediate fallback now checks normalized original builder and acting
families before transferring the durable reviewer claim. It checks again after
the primary finishes, including model-unavailable and quota-exhausted results.
Unknown, same-family and Grok acting candidates cannot receive the claim.
The primary failure and settlement budgets remain authoritative when no eligible
fallback exists.

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
