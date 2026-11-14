# REVIEWERLEASECAP-01

## Summary

Report-only Phase 0 finding: the streamed claim uses a three-hour default
ceiling before load scaling, permitting 18-hour leases at the default multiplier.
Added synthetic 14-hour and 18-hour reproductions and a
[SEV2 report](../postmortems/SEV2-REVIEWERLEASECAP-01-long-streamed-reviewer-leases.md)
with attribution limits and recommendations.

## Interface changes

None. Runtime behavior and configuration remain unchanged because source
history and canonical documentation establish the ticket's report-only condition.

## Verification

Under `cwp_dispatch.worker_validation`, with a 600-second command bound:

- `NETGUARD_LOG=/tmp/reviewerleasecap-01-netguard.log PATH=/Users/Shared/evalbench/work/netguard/bin:$PATH node --test test/reviewerleasecap-01.test.mjs`:
  two tests passed.
- `node node_modules/eslint/bin/eslint.js --fix test/reviewerleasecap-01.test.mjs`:
  passed with no diagnostics or rewrites.

Only the added test file was run, as required by the ticket's scoped validation
constraint. No runtime files changed.
