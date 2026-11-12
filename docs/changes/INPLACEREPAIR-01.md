# INPLACEREPAIR-01

An exhausted open pull request can reserve one owned repair on its existing
branch. The dispatch helper journals an epoch under the closer intent and
budget fences. A changed builder head consumes that epoch through the existing
review-request/claim CAS, even after lifetime exhaustion. Its review reason
records the epoch; a fresh closure episode retains all prior charge history.
Canonical next-action and health projections retain that reservation as the
remediation owner through synchronous provisioning and publication. Two epochs bound automatic repair; the existing wait store pages once with
the full history. No replacement pull request is created.

Harness faults reuse the closer's inconclusive-refund/backoff contract.
Review harness failures receive an idempotent CAS refund and an owned retry,
bounded to three receipts per PR across heads, with failure evidence retained.
Later failures retain ordinary infrastructure cap/alert handling. Bare
wall-clock expiries and signal exits remain unknown.
Strict findings, exact-head evidence and all merge predicates remain required.
Fixtures are synthetic and offline.

After the companion dispatch integration deploys and services load both
versions, the runtime owner observes the next exhausted pull request merging
on its original branch, then 24 hours with no replacement pull request opened
to escape budgets. Source tests do not establish that live receipt.

## Final comment-only remediation

### Summary

Pending repair reservations now take precedence over historical reviewed-head
epochs in watcher admission. Malformed next-action JSON falls back to the
review row's exhaustion reason, cycle exhaustion or conflict evidence.
The health runbook clarifies that ownerless STUCK observations already page
SEV1 through the watcher independently of the ticket-tier health finding.
Reviewed the existing closer admission custody guard and refreshed its stale
state source projection; its lifecycle graph is unchanged.

### Interface changes

None. Persistent shapes, lifecycle states, merge predicates and existing smoke
promises are unchanged.

### Verification

- `node --test test/inplacerepair-01.test.mjs`: 26 passed.
- `node test/run-tests.mjs test/watcher-claim-loop.test.mjs`: 169 passed.
- `node test/run-tests.mjs test/review-pipeline-health-ttm.test.mjs test/ttm-owner.test.mjs test/alert-delivery.test.mjs`: 106 passed.
- The watcher regression passes with pending-first lookup; a temporary fixture
  using the old lookup reproduces a competing claim.
- `npm run lint`: zero errors; existing warnings remain.
- `npm run typecheck:contracts`, `node scripts/validate-data-model-catalog.mjs`
  (94 entries) and `git diff --check`: passed.
- `node --test --test-name-pattern 'SMV independent graph|SMV ignores unrelated source comments' test/smv.test.mjs`:
  both previously failing source projection tests passed.
- `bash demo/research-finding-walkthrough.sh`: three byte-stable deliveries.

The existing Node 22 and Node 26 CI failures both identified only the stale
closer source projection; no workflow, check or CI gate was changed.

## CI repair (Node 22 and Node 26)

The health runbook paragraph no longer repeats the backticked stalled-PR
finding code, so the documented finding set again equals the emitted
definitions. The concurrent reservation test now bounds `EBUSY` retries by a
10-second deadline instead of 100 short attempts; it still asserts exactly
one owner and one ledger epoch per round. No source, check or gate changed.

## Reservation and harness retry remediation

### Summary

The watcher now retires terminal repair reservations, or proven absent launches
after a ten-minute provisioning deadline, under the ledger flock. Observations
are paced at thirty seconds; live and unknown launches retain custody. Corrupt
or busy ledger operations defer only that PR. Reviewer harness refunds are
bounded to three per PR across heads, store at most 512 characters of failure
evidence, and read already-applied receipts without writing. Bare signal exits
and free-text closer failure details cannot establish refundable faults.

### Interface changes

Repair epochs add ownerObservedAt, ownerState and nullable ownerLaunch.
Terminal reservations leave the existing ownership projections. Lifecycle
values and merge checks are unchanged. Canonical ledger, runbook and lifecycle
declarations describe retirement and bounded reviewer retries. The companion
Agent OS SPEC is outside this repository; its currency remains an operator
follow-up for the repair/refund contract in src/repair-epochs.mjs and
src/review-harness-retry.mjs.

### Verification

- `node test/run-tests.mjs test/watcher-claim-loop.test.mjs test/inplacerepair-01.test.mjs`: 201 passed.
- The combined targeted run also passed the inconclusiveretry-01b, ttm-owner
  and smv files (34 tests); two new watcher fixture failures were corrected
  before the final 201-test run above.
- `npm run lint`: zero errors (existing warnings); changed-source ESLint: clean.
- `npm run typecheck:contracts`: passed.
- `node scripts/validate-data-model-catalog.mjs`: 94 entries validated.
- `bash demo/research-finding-walkthrough.sh`: byte-stable offline demo passed.
- `git diff --check`: passed. Full-suite validation is delegated to PR-head CI.

## Final fix-all review remediation

### Summary

The repair helper validates the commit SHA before database or lease I/O.
Repair admission uses one precompiled reason pattern, retaining exact-head
and epoch-ID checks. Informational refunded-spend aggregation ignores malformed
non-array closer histories. Refunded review-row messages are capped at 4096
characters including their intact idempotency receipt; repeated observations
retain retry pacing even if truncation removed the fault text. Raw failure
evidence remains in the pass journal.

### Interface changes

Invalid repair heads fail immediately with `invalid repair request`.
The ledger shape, lifecycle graph, merge predicates and smoke promises are
unchanged. The ledger data-model doc/catalog and closure runbook document the
message limit and degraded informational spend aggregation.
The companion Agent OS SPEC follow-up described above remains outside this
checkout; this remediation changes bin/repair-in-place.mjs,
src/exhausted-head-verdict.mjs, src/repair-facts.mjs and
src/review-harness-retry.mjs.

### Verification

- `node --test --test-reporter=spec test/inplacerepair-01.test.mjs`:
  34 passed, including five new boundary/receipt cases.
- `node test/run-tests.mjs test/watcher-claim-loop.test.mjs`:
  173 passed. The initial combined run hit its 180-second bound; the isolated
  watcher run completed within its 600-second bound.
- The targeted combined run passed all 18 exhausted-head-owner and SMV tests.
  Two new repair assertions incorrectly expected backoff on the first fault;
  the fixture now exercises the third fault, and all 34 repair tests passed
  on rerun.
- `npm run lint`: zero errors, 149 existing warnings; changed-source ESLint
  passed without warnings.
- `npm run typecheck:contracts`: passed.
- `node scripts/validate-data-model-catalog.mjs`: 95 entries validated.
- `bash demo/research-finding-walkthrough.sh`: three byte-stable deliveries.
- `git diff --check`: passed. Full-suite validation remains with PR-head CI.

## Final review cleanup

### Summary

Watcher admission reuses the repair ledger snapshot to resolve a historical
reviewed head when no pending epoch owns the branch. Pending custody still takes
precedence; after terminal-owner retirement the fallback reads the updated ledger.
Removed unused failure-detail arguments from the two closer outcome classifiers
and verified the state source projections already match without changing the lifecycle graph.

### Interface changes

`reconcileRepairOwner` accepts optional `includeReviewedHead: true` for watcher
admission. Other callers retain pending-owner-only results. No persistent shape,
merge predicate or smoke promise changes.

### Verification

- Canonical `hammer-validate.mjs --canonical` selection for the changed sources,
  repair regression, watcher claim-loop and complete SMV suite: 4,843 tests in
  106 files passed.
- Filesystem instrumentation: ordinary non-repair watcher subject uses one
  ledger read instead of the prior two.
- `npm run lint`: zero errors (existing warnings).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: three byte-stable deliveries.
- `git diff --check`: passed.
- Canonical projections for orchestration, watcher and closer sources already
  match `state-machines.json`; no hash or lifecycle graph edit was needed.

## Defensive head identity and refund counters

### Summary

Repair reconciliation, binding and historical lookup compare both stored and
incoming commit SHAs case-insensitively. A case-only change cannot consume a
reservation or prevent terminal-owner retirement. Review harness refunds
coalesce nullable legacy review-attempt counters to zero before decrementing.
Regression fixtures reproduced both findings before the fixes.

### Interface changes

None. Stored SHA spelling, persistent shapes, lifecycle states, merge predicates
and smoke promises are unchanged. The previously recorded companion Agent OS
SPEC follow-up remains outside this checkout.

### Verification

- `node --test test/inplacerepair-01.test.mjs test/smv.test.mjs`: 50 passed.
- `node test/run-tests.mjs test/watcher-claim-loop.test.mjs`: 173 passed.
- `npm run lint`: zero errors, 149 existing warnings.
- `npm run typecheck:contracts`: passed.
- `node scripts/validate-data-model-catalog.mjs`: 96 entries validated.
- `bash demo/research-finding-walkthrough.sh`: three byte-stable deliveries.
- `git diff --check`: passed. Full-suite validation remains with PR-head CI.

## Harness refund pacing and missing receipts

### Summary

Same-head review refunds now aggregate case-insensitive SHA variants for
progressive backoff while preserving stored spelling. An applied receipt marker
missing from the ledger emits a PR/receipt warning and returns a null receipt
without waiting, rewriting state or granting duplicate credit.

### Interface changes

Missing applied receipts consistently return `receipt: null`. Persistent shapes,
refund caps, lifecycle states and merge predicates are unchanged. The canonical
retry-cap document records the pacing and diagnostic behavior.

### Verification

- Canonical targeted validation of `test/inplacerepair-01.test.mjs`: 41 passed,
  including mixed-case third-fault backoff and missing-receipt read-only behavior.
- `npm run lint`: zero errors, 149 existing warnings.
- `npm run typecheck:contracts`: passed.
- `node scripts/validate-data-model-catalog.mjs`: 96 entries validated.
- `bash demo/research-finding-walkthrough.sh`: three byte-stable deliveries.
- `git diff --check`: passed. Full-suite validation remains with exact-head CI.
