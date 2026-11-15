# BRANCHPROTFLAKE-01

## Summary

Make both branch-protection CLI timeout tests accept budget expiry before
spawn while preserving their elapsed-time and timeout-reason assertions.
Deterministic reader tests force both orderings, prove abort propagation,
and reject a spawn attempted after admission has timed out.
See the [SEV3 report](../postmortems/SEV3-BRANCHPROTFLAKE-01-branch-protection-timeout-test-race-2026-11-14.md)
for the four reported instances and cause.

## Interface changes

None. Production code, CI configuration and timeout budgets are unchanged.

## Verification

- `node --test test/check-branch-protection-cli.test.mjs`: 13/13 passed.
- Repeat the same command serially 50 times: 50/50 runs, 650/650 tests passed
  in 26.64 s, including forced pre-spawn delay past the virtual deadline.
- `node node_modules/eslint/bin/eslint.js test/check-branch-protection-cli.test.mjs`
  and `git diff --check`: passed.

Tests use the required netguard environment and managed validation wrapper
with a 600 s bound. Node 26.10.0 was used: installed Node 22.22.3 cannot start
because `libsimdutf.34.dylib` is missing. No host package changes were made.
Only the touched test file was run, as directed by the ticket.
