# FINDINGSGHEMPTY-01

## Summary

Findings settlement keeps a batch pending when a GitHub, publication
command, or artifact read yields empty or malformed JSON. The next tick
retries with the same custody. Launched batches with a legacy settlement
parse error wait for terminal preparation, then reuse the existing outcomes
and marked PR evidence.

## Interface changes

Transient parse warnings name the operation and byte count. The batch row
keeps its existing lifecycle and release accounting. Permanent failures
continue through the existing error and release path.

## Verification

- `node --test test/findings-batch.test.mjs` passed 187 tests, including empty
  and truncated stdout, partial outcomes, branch and ref reads, recovery to an
  existing open fix PR without relaunch, and permanent failure behavior.
- `npm run lint` passed with zero errors. `npm run typecheck:contracts` and
  `bash demo/research-finding-walkthrough.sh` passed.
- The single-worker `npm test` run exceeded the local time budget and was
  stopped before producing a suite result. PR-head CI provides full-suite
  verification.

[SEV2 incident report](../postmortems/SEV2-FINDINGSGHEMPTY-01-findings-settlement-empty-json.md)
