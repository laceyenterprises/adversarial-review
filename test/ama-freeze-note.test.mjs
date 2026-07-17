// ARC-01 — freeze-note lint.
//
// v1 merge authority (`src/ama/*`, `src/follow-up-merge-agent.mjs`, the daemon
// clean-merge path) is frozen bug-fix-only until Merge Authority v2 is promoted
// out of shadow mode. This grep-based lint keeps the freeze marker and its
// docs cross-reference from silently rotting away: it fails loudly if the
// FREEZE note in `src/ama/`, the operator-runbook cross-reference, or the
// v1-snapshot baseline doc lose their freeze language.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function readRepoFile(...parts) {
  return readFileSync(path.join(ROOT, ...parts), 'utf8');
}

test('src/ama carries a FREEZE note marking v1 merge authority bug-fix-only', () => {
  const freezePath = path.join(ROOT, 'src', 'ama', 'FREEZE.md');
  assert.ok(existsSync(freezePath), 'src/ama/FREEZE.md must exist');

  const freeze = readFileSync(freezePath, 'utf8');

  // The freeze state itself.
  assert.match(freeze, /FROZEN|frozen/, 'FREEZE note must declare the frozen state');
  assert.match(freeze, /bug-fix-only|bug fixes only/i, 'FREEZE note must state bug-fix-only');
  assert.match(freeze, /no new capabilities/i, 'FREEZE note must forbid new capabilities');

  // The freeze scope — the three v1 merge-authority surfaces.
  assert.match(freeze, /src\/ama\/\*/, 'FREEZE note must name src/ama/* in scope');
  assert.match(freeze, /follow-up-merge-agent\.mjs/, 'FREEZE note must name follow-up-merge-agent.mjs in scope');
  assert.match(freeze, /daemon[- ]clean|daemon-merge/i, 'FREEZE note must name the daemon clean-merge path in scope');

  // The lift condition and its governing spec.
  assert.match(freeze, /shadow/i, 'FREEZE note must tie the lift to v2 shadow-mode promotion');
  assert.match(freeze, /docs\/SPEC-merge-authority-v2\.md|SPEC-merge-authority-v2\.md/, 'FREEZE note must cite the merge-authority v2 spec');
});

test('the merge-authority v2 spec declares the v1 freeze', () => {
  const spec = readRepoFile('docs', 'SPEC-merge-authority-v2.md');
  assert.match(spec, /frozen/i, 'MA-v2 spec must declare v1 frozen');
  assert.match(spec, /bug-fix-only/i, 'MA-v2 spec must state bug-fix-only');
  assert.match(spec, /until v2 is[\s\S]{0,20}promoted/i, 'MA-v2 spec must tie the lift to v2 promotion');
});

test('operator docs cross-reference the v1 merge-authority freeze', () => {
  const runbook = readRepoFile('docs', 'RUNBOOK-ama-closure.md');

  assert.match(runbook, /FREEZE/, 'AMA closure runbook must carry a FREEZE banner');
  assert.match(runbook, /bug-fix-only/i, 'AMA closure runbook must state bug-fix-only');
  assert.match(runbook, /SPEC-merge-authority-v2\.md/, 'AMA closure runbook must cite the MA-v2 spec');
  assert.match(runbook, /src\/ama\/FREEZE\.md/, 'AMA closure runbook must point at the FREEZE note');
});

test('the v1-snapshot baseline doc records the tag, branch, and green baseline', () => {
  const baseline = readRepoFile('docs', 'BASELINE-v1-snapshot.md');

  assert.match(baseline, /v1-working-snapshot/, 'baseline doc must name the snapshot tag');
  assert.match(baseline, /v1-maintenance/, 'baseline doc must name the maintenance branch');
  // The snapshot commit SHA (40-hex) must be pinned so the rollback floor is unambiguous.
  assert.match(baseline, /\b[0-9a-f]{40}\b/, 'baseline doc must pin the snapshot commit SHA');
  // Evidence the fixture-e2e suite was green at the tag. Bind the
  // zero-failure assertion to the fixture-e2e command row itself so an
  // edit to that row cannot pass on a "fail 0" appearing anywhere else
  // in the document (review finding on #613).
  assert.match(baseline, /npm test/, 'baseline doc must record the full-suite command');
  const fixtureRow = baseline
    .split('\n')
    .find((line) => line.includes('research-finding-end-to-end.test.mjs'));
  assert.ok(fixtureRow, 'baseline doc must record the fixture-e2e command row');
  assert.match(
    fixtureRow,
    /# fail 0/,
    'the fixture-e2e row itself must record a zero-failure result',
  );
});
