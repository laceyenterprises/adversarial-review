# ARGUSORPHANCLAIM-01

## Summary

The Argus drain recovers claims from a previous watcher process at startup.
Recovered jobs are checked against live PR heads in the same pass, so closed,
merged, or superseded work can be retired before reviews begin.

## Interface changes

Argus claims carry an optional `claimOwner` process nonce. Legacy claims from
before process startup are recovered immediately. Reviews tracked as running
keep their claims. The lease for untracked claims from the current process starts
at 60 minutes and can stretch to at most 120 minutes under load.

## Verification

- `node --test --test-concurrency=2 test/argus-backlog-retirement.test.mjs test/argus-security-drain.test.mjs test/argus-security-queue.test.mjs` passed all 58 tests.
- `node test/run-tests.mjs test/argus-backlog-retirement.test.mjs test/argus-security-drain.test.mjs test/argus-security-queue.test.mjs` passed all 58 tests in the isolated runner.
- `npm run lint` completed with zero errors, `npm run typecheck:contracts` passed, and `bash demo/research-finding-walkthrough.sh` produced three byte-stable deliveries.
