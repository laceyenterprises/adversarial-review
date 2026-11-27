# LEGACYPRWRITE-01

## Summary

Use the PR owner's GitHub App installation for external-owner legacy PR writes
and for the live identity read that precedes them.

## Interface changes

`legacy-pr-write.mjs` includes the exception message and up to 800 trailing
characters of redacted child stderr for a thrown failure. Temporary failures
still exit 75 and numeric child exit codes are preserved.

## Verification

`node --test test/legacy-pr-identity.test.mjs` reproduces the wrong default
credential and missing exception on the baseline, then passes with the fix
under netguard.

[SEV3 report](../postmortems/SEV3-legacy-pr-write-used-default-owner-token-2026-11-27.md)
