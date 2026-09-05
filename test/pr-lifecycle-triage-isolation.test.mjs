import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard test (see the 11 sibling source-reading guards in this suite).
//
// `syncPRLifecycle` used to await the REMOTE Linear triage sync inside the same
// try block that ends with the local `stmtMarkMerged` / `stmtMarkClosed` write.
// A remote failure therefore aborted the branch before the local write, the row
// stayed `pr_state='open'`, and every later tick re-fetched the PR and
// re-attempted the same failing remote call. Observed in production as 8x
// `leaving lifecycle row open for retry: database is locked`.
//
// GitHub has already told us the PR merged or closed; that fact is settled and
// must be recorded locally regardless of Linear's availability. This pins the
// ordering so the coupling cannot be reintroduced.
const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pr-lifecycle-sync.mjs'),
  'utf8',
);

function branchSlice(startMarker) {
  const start = SRC.indexOf(startMarker);
  assert.ok(start > 0, `branch marker not found: ${startMarker}`);
  return SRC.slice(start, start + 4000);
}

for (const [label, marker, catchMsg, markStmt] of [
  ['merged', 'was merged — syncing Linear', 'merged-PR triage sync failed for', 'stmtMarkMerged.run('],
  ['closed', 'was closed (unmerged) — syncing Linear', 'closed-PR triage sync failed for', 'stmtMarkClosed.run('],
]) {
  test(`${label} branch: the remote triage sync cannot block the local lifecycle write`, () => {
    const slice = branchSlice(marker);

    const triageIdx = slice.indexOf('operatorSurface.syncTriageStatus(');
    const catchIdx = slice.indexOf(catchMsg);
    const markIdx = slice.indexOf(markStmt);

    assert.ok(triageIdx > 0, `${label}: triage sync call not found`);
    assert.ok(catchIdx > 0, `${label}: triage sync is not wrapped in its own catch`);
    assert.ok(markIdx > 0, `${label}: local mark statement not found`);

    // The isolating catch must sit between the remote call and the local write,
    // which is only true when the write is OUTSIDE the triage try block.
    assert.ok(
      triageIdx < catchIdx && catchIdx < markIdx,
      `${label}: expected triage call -> its own catch -> local mark; got ` +
        `triage=${triageIdx} catch=${catchIdx} mark=${markIdx}`,
    );
  });
}

test('the owed-work ordering before the mark is preserved', () => {
  // fireDagAutowalkOnMerge must still run BEFORE the mark: its comment states
  // that persisting owed work first is what leaves the row eligible for retry
  // when the LOCAL write fails. This fix isolates the remote call only.
  const slice = branchSlice('was merged — syncing Linear');
  const autowalkIdx = slice.indexOf('fireDagAutowalkOnMerge(');
  const markIdx = slice.indexOf('stmtMarkMerged.run(');
  assert.ok(autowalkIdx > 0, 'autowalk call not found');
  assert.ok(autowalkIdx < markIdx, 'owed work must still be persisted before the mark');
});
