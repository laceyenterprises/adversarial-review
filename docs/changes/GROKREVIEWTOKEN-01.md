# GROKREVIEWTOKEN-01

## Summary

Seed and refresh the Grok reviewer's GitHub App token through the OAuth broker
when both Grok lane switches are enabled. Disabled lanes skip broker requests;
Grok startup failure warns and continues without posting authority.

## Interface changes

The watcher and follow-up launchers default and export
`GROK_REVIEWER_AUTH_VIA_BROKER=true`. Runtime refresh recognizes
`GH_GROK_REVIEWER_TOKEN` and the Grok reviewer identity aliases, using the shared
provider override and optional identity pins. Lane defaults remain disabled.
See the [SEV4 report](../postmortems/SEV4-GROKREVIEWTOKEN-01-the-grok-reviewer-token-had-consumers-but-no-producer-2026-11-16.md).

## Verification

All test commands ran offline through the bounded worker validation runner.

- `node --test --test-concurrency=2` exercised all 12 matching and adjacent
  test files. The final broker/launcher run passed 93 tests; the serialized
  `test/watcher-claim-loop.test.mjs` run passed all 185 tests.
- The other scoped files covered authentication attempt budgets, slim-review
  eligibility, the portable installer, follow-up maintenance, the small-change
  classifier, reviewer context, Grok configuration, and Grok builder routing.
  Their tests passed.
- `npm run lint`: zero errors; existing warnings remain.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed, with three byte-stable
  transcript deliveries.
- `shellcheck scripts/lib/reviewer-broker.sh` and `zsh -n` over all three
  edited launchers: passed. This repository has no shellcheck gate script.
- `npm test`: the 900-second attempt reported over 17,000 tests before its
  cap. It reported an unrelated failure in the untouched hammer self-rebase
  `ci-old-reply` fixture. Its checkout guard also detected a rate-limit binding
  written by an overlapping direct test run. The claim-loop suite was rerun
  without overlapping tests and passed; the full suite is not claimed green.
