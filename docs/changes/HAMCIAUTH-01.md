# HAMCIAUTH-01: UNKNOWN local validation defers to exact-head CI and does not park the PR

## Summary

Suppose a hammer's canonical validation stops with no verdict because of a
timeout, a budget stop or a kill for host load. The run observed no local
failure, the checkout was clean with the remediation committed at that exact
head, and the repository declares required contexts. That validation now hands
its authority to the exact-head required GitHub checks. This holds under the
HAM controller and with partial coverage. The close publishes the head and
merges only when those contexts are green and every unchanged review and merge
gate passes. Nothing parks the PR on `canonical-validation-operator-decision`.

Before this change, the CI-authoritative escape needed both complete per-check
coverage and the absence of `HAM_CONTROLLER_RECORD`. A timed-out run cannot
have complete coverage, and every close round runs under the controller. In
practice, every timeout under load stranded an unpublished remediation in
operator custody.

## Interface changes

- `src/ama/local-validation-unknown.mjs`: the new `unknownDefersToCi()` holds the
  whole rule. It requires a deferrable reason, no failure flag or failed check
  row, `cleanCheckout === true` and declared contexts.
  `hasCompletedUnknownValidationEvidence()` accepts `cleanCheckout: true` in
  place of `coverageComplete: true`. Legacy receipts still qualify through
  `coverageComplete`.
- `bin/hammer-validate.mjs`:
  - Every deferral records `cleanCheckout`, and the controller exclusion and
    the coverage requirement are removed.
  - The validator cannot certify a controller-owned stop itself, so
    `--check-deferred` and the next `--canonical` call re-judge it from the final
    check receipt after the controller certifies drain (`quiescent`,
    `validation-stopped`, drained, lease disposed). A qualifying head continues
    its own source custody and rewrites the receipt with `cleanup: finished`.
    `hammer-close.sh` then runs its existing single extra round, which publishes
    the head and waits for CI.
  - A controller stop that may still continue skips the early terminal audit.
  - In conflict-repair publication, partial coverage with no failure now
    selects `ci` instead of `redrive`.
- `src/ama/deferred-source-custody.mjs` and `src/ama/closer-successor.mjs`: a
  parked hold can now resume. The watcher continues it, records `publishedHead`
  and lets the ordinary closer re-drive proceed without paging when all of the
  following hold:
  - the hold's source is the published live head and the hold is clean;
  - the retained `deferred.json` names a deferrable reason with no local failure;
  - `validation.json` has no failed row;
  - the repository declares required contexts.
  `dispatch-closer` and closure orchestration pass the declared contexts in.
- `bin/hammer-validate.mjs` prints an advisory notice when canonical validation
  starts on an uncommitted checkout. The incident's retained custody showed
  that every stranded run validated uncommitted edits. A timeout there cannot
  defer to CI, because no published head would carry those edits. The notice
  does not refuse the run: merge-agent callers can still validate a dirty tree.
- `templates/hammer-prompt.md`: the repair step commits before validation. The
  G2 deferral rule says that a timeout with no local failure continues to the
  close and is never parked.

Unchanged: strict mode, the exact-head required-context gate in
`hammer-merge.sh` and the queue, review verdicts, hold labels and protected
paths. A local failure is never CI-authoritative. Undeclared contexts, a dirty
checkout, unconfirmed cleanup, process-inspection denial and unpublished
watcher-side source keep the existing custody.

## Verification

- The proof came first. The scenarios in `test/hamciauth-01.test.mjs` ran
  against the unmodified tree. With the controller drained, the source bundled
  and cleanup finished, `--check-deferred` exited 75 with "Operator decision
  required". The standalone timeout with 2 of 5 passing checks exited 124 with
  `ciAuthoritative: false`. The watcher paged for a published clean head.
- `node --test test/hamciauth-01.test.mjs`: 9/9 pass. One test also checks the notice for uncommitted checkouts.
- Related suites: `mrq-20-validation-unknown`, `hammer-validation-deferral`,
  `deferred-source-custody`, `inconclusiveretry-01b`, `hamconflictcustody-01`,
  `closersockpath-01`, `finalization-queue-merge`, `hamcontrollerscript-01`,
  `hamlateaudit-01`, `hammertrim-contract`, `hammer-prompt-contract`,
  `closergates-01`, `ama-hammer-retry-cap`, `closer-next-action`,
  `closerrereviewrace-01`, `finalcaphandoff-01`, `laneauto-01`, `smv` and
  `ama-closer-lease-finalization` pass. The MRQ-20 fixture now also scrubs
  `AGENT_OS_WORKER_LRQ_ID`. Without that, a worker's own launch identity leaked
  in and turned two standalone cases red even on the unmodified tree.
- ESLint on the changed sources, `npm run typecheck:contracts` and
  `node scripts/validate-data-model-catalog.mjs` pass.
