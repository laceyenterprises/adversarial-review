# REPAIRFENCE-01

## Summary

An operator PR update can replace an `absent-unfenced` repair reservation when
the automatic remediation round budget is exhausted and a fresh canonical
lookup confirms absence. The predecessor's terminal audit and the successor
reservation are written together, preserving spend and refund history.
Supersession tolerates monotonic watcher absence-count growth, retains the
committed enqueue-fence requirement for unscoped CWP conflicts, and observes
the existing deduplicated cap page when replacements exceed two entries.

## Interface changes

The local helper accepts an operator-intent environment hint from the Agent OS
caller. A successful replacement returns `supersedesEpochId` and the exact
`baseHead` for the successor's force-with-lease publication.
Unscoped CWP supersession returns `repair-cwp-enqueue-fence-required`; operators
must use the existing fenced retirement procedure.

Operator intent currently comes from `HQ_REPAIR_REQUEST_KIND=operator-pr-update`,
an inheritable environment hint rather than authenticated request provenance.
The Agent OS companion must set it for one interactive operator request only
and strip it from worker and automatic child environments. Enforcing that
producer contract and replacing it with request-bound provenance tied to
`ownerKey` are superproject follow-ups; the producer is outside this repository.
This round documents that limitation without claiming to verify isolation.

## Verification

The offline reservation fixtures reproduce the old `repair-owned` result and
exercise exhausted and available budgets, current and newly live owners,
dispatch transport failure, automatic callers, moved heads and history
preservation.

`node --test --test-concurrency=2 test/repairdispatchread-01.test.mjs
test/inplacerepair-01.test.mjs test/repairownerscope-01.test.mjs
test/repairownerscope-02.test.mjs test/repair-follow-up-claim.test.mjs` passed
166 tests. Lint reported zero errors. Contract typechecking and the offline
research finding walkthrough passed.

Final comment-only remediation also passed the targeted reservation and
fenced-retirement suites (181 tests). After adding the final page and replay
assertions, this command passed 170 top-level tests, including the watcher
harness's 202 internal claim-loop cases:

```sh
node --test --test-concurrency=2 test/repairdispatchread-01.test.mjs \
  test/inplacerepair-01.test.mjs test/repairownerscope-01.test.mjs \
  test/repairownerscope-02.test.mjs test/repair-follow-up-claim.test.mjs \
  test/watcher-claim-loop.test.mjs
```

Lint had zero errors (147 existing warnings); focused lint on both changed
production files was clean. Contract typechecking, the offline walkthrough,
`node scripts/validate-data-model-catalog.mjs` (104 entries), and
`git diff --check` passed. No full local suite was run; PR-head CI is the
full-suite merge gate. Existing smoke commands are unchanged; source tests do
not establish deployed companion environment isolation.
