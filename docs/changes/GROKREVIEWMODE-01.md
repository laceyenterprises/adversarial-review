# GROKREVIEWMODE-01

## Summary

Add an explicit Grok reviewer mode, preserving existing opt-in behavior by
default while supporting fallback-only quota coverage. See the
[SEV4 report](../postmortems/SEV4-GROKREVIEWMODE-01-enabling-the-grok-reviewer-would-have-replaced-every-primary-reviewer-2026-11-16.md).

## Interface changes

`grok.reviewer.mode`: `off | fallback | always-on`, default `always-on`.
`AGENT_OS_GROK_REVIEWER_MODE` overrides the file value. Row fallback follows
Gemini; AFH offers Grok after Gemini only with known grounding. Selection logs
include mode, source and replaced model; the roster exposes the Grok mode.
The shared parity fixture pairs with GROKREVIEWMODECFG-01 in the OS repository.

## Verification

- The 124 test files referencing the changed routing/config modules and CLI passed
  under `node --test --test-concurrency=2` with the existing
  `test/helpers/rate-limit-state-isolation.mjs` preload. This includes all 185
  watcher claim-loop assertions and the updated offline ESM fixtures.
- `npm run lint`: passed, zero errors (existing warnings).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed, byte-stable deliveries.
- `npm test`: attempted the 885-file full suite; the clean run reached the
  runner's fixed 900-second timeout after 3,316 passing assertions, with no
  assertion failures reported before the cutoff. Full-suite completion remains
  unverified locally. Tests used netguard and bounded worker validation.
