import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard test (see the sibling source-reading guards in this suite).
//
// A Linear triage failure must bubble to the branch-level catch so the
// reviewed_prs row stays open and the full PR lifecycle sync retries. Swallowing
// this remote failure would mark the row merged/closed while leaving Linear
// permanently stale.
const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pr-lifecycle-sync.mjs'),
  'utf8',
);

function branchSlice(startMarker) {
  const start = SRC.indexOf(startMarker);
  assert.ok(start > 0, `branch marker not found: ${startMarker}`);
  return SRC.slice(start, start + 4000);
}

for (const [label, marker, failureMsg, markStmt] of [
  ['merged', 'was merged — syncing Linear', 'Failed to sync merged PR', 'stmtMarkMerged.run('],
  ['closed', 'was closed (unmerged) — syncing Linear', 'Failed to sync closed PR', 'stmtMarkClosed.run('],
]) {
  test(`${label} branch: remote triage failures leave the lifecycle row retryable`, () => {
    const slice = branchSlice(marker);

    const triageIdx = slice.indexOf('operatorSurface.syncTriageStatus(');
    const markIdx = slice.indexOf(markStmt);
    const failureIdx = slice.indexOf(failureMsg);

    assert.ok(triageIdx > 0, `${label}: triage sync call not found`);
    assert.ok(markIdx > 0, `${label}: local mark statement not found`);
    assert.ok(failureIdx > 0, `${label}: branch-level retry catch not found`);
    assert.equal(
      slice.includes(`${label}-PR triage sync failed for`),
      false,
      `${label}: triage sync must not have an isolated swallowing catch`,
    );
    assert.ok(
      triageIdx < markIdx && markIdx < failureIdx,
      `${label}: expected triage call -> local mark -> branch-level catch; got ` +
        `triage=${triageIdx} mark=${markIdx} catch=${failureIdx}`,
    );
  });
}

test('the owed-work ordering before the mark is preserved', () => {
  // fireDagAutowalkOnMerge must still run BEFORE the mark: its comment states
  // that persisting owed work first is what leaves the row eligible for retry
  // when the LOCAL write fails.
  const slice = branchSlice('was merged — syncing Linear');
  const autowalkIdx = slice.indexOf('fireDagAutowalkOnMerge(');
  const markIdx = slice.indexOf('stmtMarkMerged.run(');
  assert.ok(autowalkIdx > 0, 'autowalk call not found');
  assert.ok(autowalkIdx < markIdx, 'owed work must still be persisted before the mark');
});
