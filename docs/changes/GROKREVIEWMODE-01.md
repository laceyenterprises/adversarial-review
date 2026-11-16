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

Final Comment-only remediation applies the same Grok row-quota layer to Gemini
spawn retries before AFH, carries the replaced reviewer on always-on base
selection, and permits bypass only for that reviewer's quota hold. Roster text
and JSON now include Grok and compute defaults through the production routing
pipeline with both mode knobs and lane enablement. Existing missing-route and
exclusion guards were confirmed at the reviewed head and covered explicitly;
they did not require production changes. Existing lifecycle states, persistent
store shapes and deployed smoke promises remain unchanged.

## Verification

Final Comment-only remediation:

- Four targeted routing/AFH/roster/selection files: 118 tests passed using
  `node test/run-tests.mjs` with explicit file arguments.
- `node test/run-tests.mjs test/watcher-claim-loop.test.mjs`: all 186 tests
  passed, including the new Gemini-to-Grok quota retry and durable claim transfer.
- `node test/run-tests.mjs test/smv.test.mjs`: all 11 tests passed, including
  the existing disposable-Git smoke. The producer state projection and
  generated README diagrams remain byte-identical.
- `npm run lint`: zero errors (149 existing warnings);
  `npm run typecheck:contracts`: passed;
  `bash demo/research-finding-walkthrough.sh`: passed, byte-stable deliveries.
- No full-suite run in this final round; PR-head CI owns that validation.

Original implementation validation:

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
