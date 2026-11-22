# CLOSERSEED-01

## Summary

The committed worker-model seed now covers every closer class the AMA closer
dispatches (`hammer`, `hammer-corp`, `hammer-claude`, `hammer-claude-corp`).
A retryable worker-registry read failure therefore resolves the closer model
from the seed (`modelSource=committed-seed`) instead of failing resolution and
deferring every closer with `harness-fallback-resolver-error`. Incident report:
[`docs/INCIDENT-2026-11-22-CLOSERSEED-01.md`](../INCIDENT-2026-11-22-CLOSERSEED-01.md).

## Interface changes

- `src/adapters/agent-runtime/local/worker-model-seed.json` gains four class
  entries with `defaultModel` and `allowedModels`. Their values mirror the
  seed's existing entries for the same model family (`hammer`/`hammer-corp`
  mirror `remediator-codex`; `hammer-claude`/`hammer-claude-corp` mirror
  `remediator-claude`). No reasoning default is seeded: the resolver does not
  support reasoning levels for closer classes.
- `HAMMERS` in `src/worker-token-pool.mjs` is now exported so the coverage test
  can read the closer alias set.
- Seed precedence is unchanged: seed only on retryable infrastructure registry
  failures; a readable registry that withdrew a class still fails closed; a
  registry-approved pin is still honored.

## Verification

- `node --test test/remodel-fallback.test.mjs` — 130 pass. With the seed file
  reverted to base, 43 fail (new outage, coverage and seed-shape tests).
- `node --test test/ama-harness-fallback.test.mjs`,
  `test/worker-registry-entrypoints.test.mjs`, `test/registry-model-session.test.mjs`,
  `test/host-observation-refusal.test.mjs`, `test/efforttune-02.test.mjs`,
  `test/agent-runtime-local.test.mjs`, `test/closerfallbackfailopen-01.test.mjs`,
  `test/remgemini-01-gemini-remediation-lane.test.mjs`,
  `test/watcher-pending-failure-claim.test.mjs` — all pass.
- Tests that asserted the old behavior (closer defers on a registry outage) in
  `test/remodel-fallback.test.mjs`, `test/ama-harness-fallback.test.mjs` and
  `test/worker-registry-entrypoints.test.mjs` were rewritten to assert the seed
  fallback.
- `test/merge-agent-harness.test.mjs` (12 fail), `test/worker-token-pool.test.mjs`
  (16 fail) and `test/standalone-reviewer-execution.test.mjs` (27 fail) fail
  identically on an untouched archive of the base commit.
