# LANEAUTO-01

## Summary

Eligible final-round Comment-only exact-head reviews get one builder fix-all
round through the existing remediation queue. The pushed head needs a fresh
full review; zero findings select normal daemon merge, while remaining findings
fall back to the configured hammer/operator route. Conflicts and CI-only hammer
repair remain available. Public examples and fixtures are synthetic.

Final Comment-only remediation removes the redundant nonexistent mergeability
attribute check and relies on the shared structural/conflict decision rows.
Archived stopped fix-all receipts already use the shared historical-job reader;
a direct regression now proves terminal fallback without remote reads or
reenqueue. The final-fix-all catalog contract lives in its own LANEAUTO-01
fragment. The HAMCLOSE replay now exercises the final builder round before
terminal fallback instead of expecting immediate hammer dispatch.

## Interface changes

The existing `closureHandoff` receipt admits reason `final-fix-all`, full review
and trigger `final-round-review`. One round is claimable despite spent ordinary
finding rounds. Head/reason receipts and the PR closer-intent lock bound enqueue
and exclude concurrent closer admission, including rescue. Pending receipt
ownership survives admission delay. No config, check, label, lifecycle enum,
strictness, merge predicate, attestation or lease changes.

Canonical contracts: [closure runbook](../RUNBOOK-ama-closure.md),
[state machine](../STATE-MACHINE.md), and
[follow-up data model](../data-model/follow-up-jobs.md).
SRE's float/restart and natural-traffic acceptance are declared in
[the operator plan](../../modules/worker-pool/post-merge-actions/LANEAUTO-01.yaml); no live actions ran here.

## Verification

Targeted files run individually through `cwp_dispatch.worker_validation` with
600-second bounds and netguard. Full host suites are intentionally excluded by
the ticket.

- `test/laneauto-01.test.mjs`: 18 passed.
- `test/hamconflictowner-01.test.mjs`: 19 passed.
- `test/closer-next-action.test.mjs`: 97 passed.
- `test/watcher-daemon-clean-merge.test.mjs`: 125 passed.
- `test/watcher-claim-loop.test.mjs`: 161 passed in 225 seconds with a
  600-second bound, after the shorter 60/180-second limits expired.
- `test/watcher-claim-loop.test.mjs`: 161 passed.
- `test/pr-next-action.test.mjs`: 283 passed.
- `test/adversarial-gate-status.test.mjs`: 101 passed.
- `test/follow-up-jobs.test.mjs`: 172 passed.
- `test/smv.test.mjs`: 11 passed, including the updated offline handoff smoke.
- `npm run lint`: zero errors (152 existing warnings); changed-file ESLint
  also passed with zero errors.
- `npm run typecheck:contracts` and the byte-equivalence research walkthrough:
  passed.
- Report frontmatter/relative links and the operator-only post-merge plan:
  validated locally.

Final Comment-only remediation validation:

- `node --test test/laneauto-01.test.mjs test/hamconflictowner-01.test.mjs test/smv.test.mjs`
  through `bin/run-bounded.sh --timeout 60`: 20, 19 and 13 tests passed.
- `node --test test/hamclose-replay.test.mjs` through the same bounded runner:
  20 passed, including the fixture that failed on both prior PR-head CI lanes.
- Changed-source ESLint, `npm run typecheck:contracts`,
  `node scripts/validate-data-model-catalog.mjs` (92 entries) and
  `git diff --check`: passed. No full local test suite ran.
- `test/watcher-daemon-clean-merge.test.mjs`: 125 passed.
- `npm run lint`: zero errors, 152 existing warnings. The research-finding
  walkthrough retained byte-equivalent output. A local catalog-fragment
  assertion confirmed final-fix-all separation and preserved conflict-primary
  metadata.
