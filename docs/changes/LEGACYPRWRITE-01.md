# LEGACYPRWRITE-01

## Summary

Use the PR owner's GitHub App installation for external-owner legacy PR writes
and for the live identity read that precedes them.
Final remediation removes inherited home-token aliases, refresh commands and
expiry metadata on this route, preserves the source credential's role, and
checks token lifetime immediately before launching the wrapped command.

## Interface changes

`legacy-pr-write.mjs` includes the exception message and up to 800 trailing
characters of redacted child stderr for a thrown failure. Temporary failures
still exit 75 and numeric child exit codes are preserved.
Local diagnostics redact entitled-token assignments while retaining filesystem
paths. Owner minting runs under its broker budget before the identity-read timer.
The owner selector accepts an optional `minValidityMs` floor; cached and minted
tokens must have sufficient known expiry, with forced minting on a floor miss.
The PR writer requires the command timeout plus termination grace and two minutes
of slack, refusing an insufficient or unknown lifetime before command execution.
Home-owner command environments and generic selections without a floor retain
their existing behavior. See the [closure runbook](../RUNBOOK-ama-closure.md).

## Verification

`node --test test/legacy-pr-identity.test.mjs` reproduces the wrong default
credential and missing exception on the baseline, then passes with the fix
under netguard.

Final-round targeted validation: `node test/run-tests.mjs
test/legacy-pr-identity.test.mjs test/github-owner-token.test.mjs
test/legacy-lane-write-run-budget.test.mjs` passed all 57
tests offline, covering credential isolation, inferred roles, launch-time renewal,
insufficient/unknown expiry, shared-flight floors, separate mint/read budgets and
local diagnostic redaction.
`npm run lint` passed with zero errors (147 existing warnings);
`npm run typecheck:contracts`, `bash demo/research-finding-walkthrough.sh` and
`git diff --check` also passed. The full suite is reserved for PR-head CI.

[SEV3 report](../postmortems/SEV3-legacy-pr-write-used-default-owner-token-2026-11-27.md)
