# HAMCONFLICTOWNER-01

Fresh re-land review fixes: a missing stopped archive yields job unavailable; non-array inline-comment JSON contributes no inline comments.

## Summary

A closer that cannot prove its conflict replay hands the current PR head to
the existing follow-up remediation queue. The watcher consumes the terminal
audit before closer cap/retry selection, and keeps one durable remediation
owner per head. The work order resolves conflicts against the current base,
preserves both sides, addresses open review findings and pushes a new head
for normal full review with full-range validation.

## Interface changes

Follow-up jobs optionally retain `closureHandoff` with `reason`, `headSha`,
`review: "full"` and host-captured untrusted `reviewContext`. The job's existing
PR identity, `revisionRef`, `jobId` and status form the ownership receipt.
Shared next-action snapshots carry this handoff and select `remediate` /
`remediator` for a matching pending job through admission delays. Existing
builder-tag and account routing, live custody, queue claim and merge gates
remain authoritative. Handoff read/enqueue failures retain the stop for a
later watcher pass.

Final comment-only remediation captures inline diff comments from the
paginated REST endpoint alongside review summaries and PR issue comments,
preserving discussion links in the existing `body`/`url` projection. Unreadable
inline context retains the stop for retry. Archived duplicate receipts read
the stored historical job so timestamps and worker metadata survive archival;
their stopped-archived status and non-live ownership remain unchanged.

The existing cross-process claim keys this work by PR/head/reason, including
archived jobs and changes to work-order wording. A read-only receipt lookup
preserves an enqueued owner through later GitHub outages. Published conflict
remediation retains normal review intent even on the last allowed round;
it cannot use the suppressed final-push shortcut.

Only `conflict-primary-unproven` takes this route. Timeout retry and proven
replay publication remain unchanged, and unproven replays still cannot publish.
No config key, queue status, CI check, label or live activation is added.

The private rescue reader should consume the returned `closureOwner`
(`action: "remediate"`, `actor: "remediator"`,
`reason: "conflict-primary-unproven"`) and `remediation.jobId`, or project
the matching job's `closureHandoff` into `remediation.job` in the shared
next-action snapshot. It must retain that pending owner instead of dispatching
another closer. No private repository is changed here.

## Rescue remediation (PR 1790)

Closeout compares published commit SHAs case-insensitively, including its
retry and final-push decisions. Conflict handoffs still require full review
on the last allowed round when Git and GitHub use different hex casing.
Saved review context keeps the 50 most recent nonblank entries across sources,
with bodies limited to 2,000 characters and URLs to 2,048 characters. Truncated
bodies end in an ellipsis; discussion links retain access to omitted context.
The job shape and round budgets are unchanged.

## Verification

Rescue remediation:

- Bounded `npm test -- test/hamconflictowner-01.test.mjs
  test/remediation-closeout-next-action.test.mjs test/closer-next-action.test.mjs
  test/watcher-claim-loop.test.mjs`: 321 passed, zero failures. Coverage includes
  mixed-case published heads on green and pending CI at the final round, and
  bounded recent context across sources/pages in both the stored job and prompt.
- `npm run lint`: zero errors (152 existing warnings); changed-file ESLint
  `--fix`, `npm run typecheck:contracts`, catalog validation, the offline
  research walkthrough and `git diff --check`: passed.

- Full bounded `npm test`: exited nonzero; output includes failures in the
  untouched `test/follow-up-remediation.test.mjs` local OAuth startup fixtures
  (`inherited HOME does not satisfy the requested local OAuth owner contract`).
  This run does not establish a green full-suite result; scoped tests above
  remain green. No unrelated runtime/authentication code was changed.

Final comment-only round:

- `node test/run-tests.mjs test/hamconflictowner-01.test.mjs
  test/closer-next-action.test.mjs test/follow-up-review-claim.test.mjs
  test/watcher-claim-loop.test.mjs`: 275 passed under the 180-second bounded
  runner, including paginated inline context, failed context reads and archived
  execution metadata. The initial 60-second multi-process invocation timed out
  and failed a claim assertion; the isolated runner passed all four suites.
- `npm run lint`: zero errors (152 existing warnings).
- `npm run typecheck:contracts`, `node scripts/validate-data-model-catalog.mjs`,
  `bash demo/research-finding-walkthrough.sh` and `git diff --check`: passed.
- The full local suite was not run in this round; PR-head CI owns that gate.

Synthetic fixtures exercise terminal audit consumption, actual queue admission,
same-head deduplication including terminal/archived jobs, normal full-review
work orders, delayed pending ownership, moved/closed heads, unavailable
provenance, unchanged timeout retry and unchanged successful replay behavior.
The orchestration regression proves exhausted closer attempts cannot prevent
the builder handoff or select another closer.

- `npm run lint`: passed with zero errors (existing warnings only).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed, with three
  byte-stable transcript deliveries.
- Netguard-prefixed `node --test --test-concurrency=2 --import
  ./test/helpers/rate-limit-state-isolation.mjs <files>` exercised all 162
  files selected with `git grep -l` for the edited modules and prompt. After
  corrections, the ten affected/core suites passed all 520 tests, including
  the watcher claim loop. The final meter/handoff/state-machine run passed
  another 145 tests across five suites.
- The monolithic `npm test` invocation reached the existing 900-second limit.
  The complete 809-file suite then passed in four sequential, bounded
  `npm test -- <files>` invocations through the same sandbox runner, with
  Netguard enabled: 19,071 passed, 11 skipped, zero failures or cancellations.
  No test runner, timeout, CI job or publication gate was changed.

Fresh re-land verification:

- All 810 test files passed in four sequential, bounded `npm test -- <files>`
  groups under Netguard: 19,113 passed, 11 skipped, zero failures or
  cancellations. This covers all 165 files selected with `git grep -l` for
  every edited runtime module and the prompt, including the watcher claim
  loop, closer-next-action and SMV suites.
- The handoff, remediation-closeout next-action, closer-next-action and SMV
  suites passed all 179 tests under Netguard, including both new regression
  cases and six non-array JSON shapes.
- Changed-source ESLint `--fix`, repository lint (zero errors, 152 existing
  warnings), contract typechecking and the offline research walkthrough passed.
- Source projections and README diagrams were regenerated with the existing
  SMV helpers and checked for equality. Catalog fragment overlays were
  assembled and validated locally; `catalog.json` remains a main-generated
  projection and is not committed. This checkout has no standalone generator
  for the hand-maintained `docs/STATE-MACHINE.md` contract text.
- The initial direct affected-file invocation passed 164 of 165 files; the
  existing bounded-runner process-cleanup fixture returned `EPERM` / status
  125 instead of 124. The same assertion passed in the normal sandbox batch
  run without changing the runner or fixture.
