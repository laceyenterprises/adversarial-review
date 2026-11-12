# AGYSTALELAUNCH-01 — A stale `launching` reviewer run record cannot hold an agy reviewer holder

## Summary

The agy reviewer holder pool keeps a holder out while a reviewer run record
from a previous watcher still runs on it. For a `launching` record with a PGID,
"still runs" meant only "the PGID is alive". The start-time identity check ran
only for terminal states. A process group ID is not an identity: after macOS
reused one for an unrelated process, a weeks-old `launching` record held the
only Gemini holder indefinitely. A watcher restart did not clear it.

Two rules now apply:

- **Identity is proven for every state.** A live PGID is the review's only when
  its leader started with it. The window runs from `spawnedAt` minus the `ps`
  rounding tolerance to `spawnedAt` plus the load-scaled launch grace, because
  cli-direct stamps `spawnedAt` before its preflight. A readable mismatch does
  not hold. Unreadable evidence still holds, as before.
- **Every `launching` hold is bounded.** A `launching` record older than the
  launch grace without a verified leader is settled `failed` and releases its
  holder. That covers no PGID, a gone or recycled group, and unreadable
  evidence. The settle also clears the PGID and is logged once. Each readiness
  pass runs this reap, and so do the watcher's startup checks, so a restart
  clears stale holds before the first lease. A `launching` record with a
  verified leader keeps holding past the grace: an Argus child's record stays
  `launching` for its whole bounded run.

The adopted-review hold log line now names the record's state, age and
identity result (`verified`, `unverified`, with the reason).

## Interface changes

- `src/adapters/reviewer-runtime/run-state.mjs` exports
  `REVIEWER_LAUNCH_GRACE_MS` (60 s, the existing null-PGID reattach grace, now
  shared with `src/reviewer-reattach.mjs`). It also exports
  `reapStaleLaunchingReviewerRunRecord(rootDir, judgedRecord, { settledAt })`,
  which settles only a record that still has the judged state, PGID and
  `spawnedAt`.
- `src/process-group-identity.mjs` exports `PGID_IDENTITY_TOLERANCE_MS`.
- `createAgyReviewerIdentityPool` accepts `launchGraceMs` (default: the
  load-scaled grace, resolved each pass) and `reapStaleLaunchingRecordImpl`. It
  returns a new `reapStaleLaunchingRecords()`.
- `runAgyReviewerStartupChecks` calls `reapStaleLaunchingRecords()` after the
  workspace sweep and returns `{ auth, sweep, reaped }`. A failed reap warns
  and never blocks startup. Final comment-only remediation removes the
  `currentPlan().multi` guard: persisted holds are scanned even with an
  undeclared owner-only pool or a runtime that no longer leases agy holders.
- No new run state: a reaped record uses the existing `launching → failed`
  transition (`reviewer-run.08`). No config key, CI check, gate or label.
  Corrected in place: `docs/data-model/reviewer-run-records.md`,
  `docs/data-model/agy-holder-leases.md`,
  `docs/RUNBOOK-antigravity-gemini-reviewer.md` and the `agyHolderLeases`
  contract text in `state-machines.json`. The `run-state.mjs` source-projection
  hash was refreshed. The reviewed `objects` graph is unchanged.

## Verification

Run individually under netguard, each bounded to 600 s, with
`ADVERSARIAL_REVIEW_TEST_TEMP_BASE=/tmp`:

- `node --test test/agystalelaunch-01.test.mjs`: 15/15 pass. Against the base
  pool logic (only the new leaf exports copied in), the 8 behaviour tests fail
  and the 7 invariant tests pass.
- `test/agy-reviewer-identities.test.mjs` 84/84, `test/agy-token-holders.test.mjs`
  32/32 and `test/watcher-reviewer-pool.test.mjs` 89/89 pass.
- `test/smv.test.mjs` 11/11, `test/watcher-reattach.test.mjs` 85/85,
  `test/reviewer-runtime-adapter.test.mjs` 84/84,
  `test/argus-security-drain.test.mjs` 11/11,
  `test/watcher-agy-auth-startup.test.mjs` 3/3,
  `test/reviewer-token-lease-recovery.test.mjs` 11/11,
  `test/gempool-routing.test.mjs` 9/9 and
  `test/reviewer-orphan-dead-reviewer-fast-path.test.mjs` 7/7 pass.
- `test/argusquota-01.test.mjs` is 31/32. Its one failure ("Argus lease
  acquisition defaults the shared pool without arguments") fails the same way
  on an unmodified `origin/main` archive.

Final remediation validation after rebasing onto fresh `origin/main`:

- The new non-multi startup regression fails with the guard present and passes
  after removal. Owner-only Antigravity also passes; both cases preserve a
  verified live record and prove repeat reaping is idempotent.
- `node test/run-tests.mjs test/agystalelaunch-01.test.mjs
  test/agy-reviewer-identities.test.mjs test/watcher-agy-auth-startup.test.mjs`:
  104/104 pass using the repository's isolated runner. An initial mixed
  `node --test` invocation passed all assertions but failed the runner's
  checkout-data isolation check; the isolated invocation resolves it.
- `node --test test/smv.test.mjs`: 11/11 pass.
- `npm run lint`: zero errors (149 existing warnings).
- `npm run typecheck:contracts`, `git diff --check`,
  `node scripts/validate-data-model-catalog.mjs` (94 entries), and
  `bash demo/research-finding-walkthrough.sh`: pass.
- Full-suite validation remains with PR-head CI.
