import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard test (see the sibling source-reading guards in this suite).
//
// A GitHub terminal observation must be recorded before fallible side effects
// such as Linear triage sync. Otherwise a downstream failure leaves the local
// row open forever, and age-based alert surfaces keep firing on a PR GitHub
// already merged or closed.
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
  test(`${label} branch: terminal state is recorded before remote triage side effects`, () => {
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
      markIdx < triageIdx && triageIdx < failureIdx,
      `${label}: expected local mark -> triage call -> branch-level catch; got ` +
        `triage=${triageIdx} mark=${markIdx} catch=${failureIdx}`,
    );
    assert.match(
      slice,
      /terminal state is recorded and side effects will retry separately/,
      `${label}: catch message should name terminal-first retry semantics`,
    );
  });
}

test('merged branch records terminal state before owed-work side effects', () => {
  const slice = branchSlice('was merged — syncing Linear');
  const autowalkIdx = slice.indexOf('fireDagAutowalkOnMerge(');
  const markIdx = slice.indexOf('stmtMarkMerged.run(');
  assert.ok(autowalkIdx > 0, 'autowalk call not found');
  assert.ok(markIdx < autowalkIdx, 'terminal state must be recorded before owed-work side effects');
});
