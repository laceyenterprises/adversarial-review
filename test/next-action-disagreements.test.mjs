import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyDisagreements, readShadowLogTail, NEXT_ACTION_ROLLOUT_DISTINCT_CASES } from '../src/next-action-disagreements.mjs';
import { caseKeyOf, nextActionShadowLogPath } from '../src/pr-next-action-shadow.mjs';

// Synthetic records only: opaque subject keys and fabricated heads.
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'next-action-disagreements.mjs');

function record(index, { source = 'closure-orchestration', at = '2026-01-01T00:00:00.000Z', next = 'hammer' } = {}) {
  const value = { schema: 'nxa-shadow/v1', kind: 'disagreement', observedAt: at, source,
    subjectKey: `subject-${index}`, head: String(index).padStart(40, '0'), passId: null, generation: null,
    fields: ['action'], legacy: { action: 'operator-hold', actor: 'operator', reason: 'retry-exhausted' },
    next: { action: next, actor: 'closure-recovery', reason: 'retry-exhausted', row: 'R07-stop' }, evidenceRefs: [] };
  return { ...value, caseKey: caseKeyOf(value) };
}

test('repeats of one case count once, across sources and passes', () => {
  const lines = [record(1), record(1, { source: 'posted-review', at: '2026-01-01T01:00:00.000Z' }), record(2),
    { kind: 'overdue', source: 'posted-review', next: { action: 'review', actor: 'reviewer' } }, 'not json', '{}']
    .map(item => typeof item === 'string' ? item : JSON.stringify(item));
  const report = classifyDisagreements(lines);
  assert.equal(report.distinctCases, 2);
  assert.deepEqual(report.scanned, { records: 4, malformed: 2 });
  assert.deepEqual(report.bySource, { 'closure-orchestration': 2, 'posted-review': 1 });
  assert.deepEqual(report.byTransition, { 'operator-hold/operator -> hammer/closure-recovery': 2 });
  assert.deepEqual(report.overdue, { count: 1, byAction: { 'review/reviewer': 1 } });
  const first = report.cases.find(entry => entry.subjectKey === 'subject-1');
  assert.equal(first.occurrences, 2);
  assert.deepEqual(first.sources, ['closure-orchestration', 'posted-review']);
  assert.equal(first.lastSeen, '2026-01-01T01:00:00.000Z');
  assert.equal(classifyDisagreements(lines, { source: 'posted-review' }).distinctCases, 1);
});

test('rollout sufficiency needs 20 classified distinct cases including both dispositions; it is guidance only', () => {
  const records = Array.from({ length: NEXT_ACTION_ROLLOUT_DISTINCT_CASES }, (_, i) => record(i));
  const lines = records.map(item => JSON.stringify(item));
  const dispositions = Object.fromEntries(records.map((item, i) => [item.caseKey, i === 0 ? 'candidate-mistake' : 'expected-correction']));
  const enough = classifyDisagreements(lines, { dispositions });
  assert.equal(enough.rollout.classifiedDistinctCases, 20);
  assert.equal(enough.rollout.evidenceSufficient, true);
  const oneKind = classifyDisagreements(lines, { dispositions: Object.fromEntries(records.map(item => [item.caseKey, 'expected-correction'])) });
  assert.equal(oneKind.rollout.evidenceSufficient, false);
  const fewer = classifyDisagreements(lines.slice(1), { dispositions });
  assert.equal(fewer.rollout.evidenceSufficient, false);
  // Repeats never inflate the count.
  const repeated = classifyDisagreements([...lines.slice(1), ...lines.slice(1)], { dispositions });
  assert.equal(repeated.rollout.classifiedDistinctCases, 19);
  assert.match(enough.rollout.note, /Human rollout acceptance only/);
});

test('aggregate output carries no subject keys, heads or case keys', () => {
  const lines = [record(1), record(2)].map(item => JSON.stringify(item));
  const report = classifyDisagreements(lines, { aggregate: true });
  const text = JSON.stringify(report);
  assert.equal(report.cases, undefined);
  assert.ok(!text.includes('subject-'));
  assert.ok(!text.includes('0000000001'));
  for (const item of [record(1), record(2)]) assert.ok(!text.includes(item.caseKey));
});

test('the tail reader is bounded and drops a partial first line', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nxa-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'log.jsonl');
  const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify(record(i)));
  writeFileSync(file, `${lines.join('\n')}\n`);
  const tail = readShadowLogTail(file, { maxBytes: 2000 });
  assert.equal(tail.truncated, true);
  assert.ok(tail.bytes <= 2000);
  for (const line of tail.lines) JSON.parse(line);
  assert.equal(tail.lines.at(-1), lines.at(-1));
  assert.deepEqual(readShadowLogTail(join(dir, 'missing.jsonl')), { lines: [], bytes: 0, truncated: false, missing: true });
});

test('the CLI is read-only, bounded and never fails on evidence', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nxa-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = nextActionShadowLogPath(root);
  mkdirSync(dirname(log), { recursive: true });
  const records = [record(1), record(2)];
  writeFileSync(log, `${records.map(item => JSON.stringify(item)).join('\n')}\n`);
  const dispositionsFile = join(root, 'private-dispositions.json');
  writeFileSync(dispositionsFile, JSON.stringify({ [records[0].caseKey]: 'expected-correction' }));
  const before = [readFileSync(log, 'utf8'), statSync(log).mtimeMs];
  const report = JSON.parse(execFileSync(process.execPath, [BIN, '--root', root, '--dispositions', dispositionsFile]));
  assert.equal(report.distinctCases, 2);
  assert.equal(report.rollout.classifiedDistinctCases, 1);
  assert.equal(report.rollout.evidenceSufficient, false);
  assert.deepEqual([readFileSync(log, 'utf8'), statSync(log).mtimeMs], before);
  const aggregate = JSON.parse(execFileSync(process.execPath, [BIN, '--root', root, '--aggregate']));
  assert.equal(aggregate.cases, undefined);
  assert.equal(aggregate.scanned.file, undefined);
  const empty = JSON.parse(execFileSync(process.execPath, [BIN, '--root', join(root, 'none')]));
  assert.deepEqual([empty.distinctCases, empty.scanned.missing], [0, true]);
  const usage = spawnSync(process.execPath, [BIN, '--bogus'], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
});
