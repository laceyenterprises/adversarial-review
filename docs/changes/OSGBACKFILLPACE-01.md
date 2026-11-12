# OSGBACKFILLPACE-01

## Summary

The explicit finding and grade backfills can now run beside the live review
pipeline without taking over the shared SQLite write lock. Before this change,
every finding pass opened an `IMMEDIATE` transaction, parsed the review body
inside it and rewrote rows even when nothing had changed. Passes ran back to
back without a yield. SQLite's busy handler is not fair, so live writers
sleeping in their bounded busy retries kept missing the lock and failed with
`database is locked`.

Finding backfill now:

- parses each pass outside any transaction;
- skips a pass whose projection is already current, using reads only;
- writes in one short immediate transaction that re-checks the pass row. If a
  live writer changed the row, the pass is re-read and re-parsed outside the
  lock, so a stale parse is never written.

Both backfills yield after every write transaction, to a bounded write duty
cycle (default 20%). Live projection (`persistReviewFindings`) behaves as before.

## Interface changes

- `src/backfill-write-pacer.mjs` (new) exports:
  - `createBackfillWritePacer({ maxWriteDutyCycle })`, returning `write(fn)` and
    `summary()`;
  - `parseWriteDutyCycle`, which accepts a decimal in (0, 1];
  - `DEFAULT_BACKFILL_WRITE_DUTY_CYCLE` (`0.2`).
- `backfillReviewFindings` and `backfillFindingGrades` accept `maxWriteDutyCycle`
  or a caller-owned `pacer`. Finding backfill also accepts an injectable `parse`.
  - The finding page result adds `written`, `skipped`, `replanned` and `pacing`.
  - The grade result adds `pacing`.
  - The `pacing` object holds `maxWriteDutyCycle`, `writeTransactions`,
    `writeMs`, `yieldMs`, `elapsedMs` and the effective `writeDutyCycle`.
  - `onPass` receipts are unchanged.
- `bin/review-findings.mjs backfill` and `bin/review-grades.mjs backfill` accept
  `--max-write-duty-cycle`. The value is validated before the database is opened.
- `src/review-finding-records.mjs` exports `BACKFILL_WRITE_PACING_SUPPORTED = true`
  and re-exports the pacer. The companion explicit backfill command refuses to
  run without the flag.
- Schemas, finding identities, `historical_projection` and backlog enrollment
  are unchanged.

## Verification

- `node --test test/osgbackfillpace-01.test.mjs`: 18 pass. The suite covers:
  - A live writer on a second connection with a 100 ms busy timeout commits
    every attempt while the backfill projects 120 synthetic new passes, then
    replays them as already captured.
  - Already-captured passes take no write transaction, even while another
    connection holds the write lock (`busy_timeout=0`).
  - Eight projection differences are each detected and repaired to the
    fixed point a full historical replay produces.
  - Parsing runs outside every transaction. A pass changed mid-flight is
    re-parsed, and the live capture is not overwritten. A pass that keeps
    changing is re-planned under the lock.
  - Historical rows keep `historical_projection=1` and enroll nothing, against
    a live control that does enroll.
  - Pacing applies to writes that insert nothing, to failed writes and to the
    grade phase.
  - The CLI flag is validated, and pacing appears in the run output.
- A/B against the origin/main code with the same synthetic probe. The writer
  hit `SQLITE_BUSY` 3 times per phase and committed only 3–12 times. That
  includes the all-captured replay that inserted nothing, which reproduces the
  incident shape. With this change it hit 0 busy errors.
- Unchanged and green: `finding-projection-contention` (9), whose two
  exact-result assertions now pick fields; `review-finding-records` (19),
  `osgbackfillenroll-01` (16), `osgboundaryflag-01` (3), `review-backfill-cli`
  (4), `review-finding-grades` (5), `findings-batch-grades` (18),
  `findings-batch` (101), `backfill-review-bodies` (19) and
  `review-body-capture` (39).
- `npm run lint` (0 errors), `npm run typecheck:contracts` and
  `demo/research-finding-walkthrough.sh` pass.
