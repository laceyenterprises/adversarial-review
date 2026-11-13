// QWV-04: data/ama-closer-outcomes is the one closer-outcome writer and
// reviewer_passes.status for closer passes is its projection. Fixtures are
// synthetic, shaped like the journal's recorded rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { appendCloserOutcome } from '../src/ama/closer-outcomes.mjs';
import {
  CLOSER_OUTCOME_SOURCE, projectCloserOutcome, projectCloserPassStatus, readCloserLeaseOutcomes, refreshCloserPassStatuses,
  summarizeCloserOutcomes,
} from '../src/ama/closer-pass-projection.mjs';
import { main as closerOutcomeStatus } from '../bin/closer-outcome-status.mjs';
import { beginReviewerPass, completeReviewerPass } from '../src/reviewer-pass-tokens.mjs';

const REPO = 'example/project';
const HEAD = 'a'.repeat(40);

// launch -> lease-terminal outcomes in terminalAt order (launch-terminal rows interleaved).
const RECORDED = {
  'lrq-landed': ['succeeded'],
  'lrq-refused': ['failed-without-merge'],
  'lrq-refused-then-landed': ['failed-without-merge', 'succeeded'],
  'lrq-superseded': ['superseded'],
  'lrq-deferred': ['deferred'],
  'lrq-retryable': ['retryable-ledger-read'],
  'lrq-merged-elsewhere': ['pr-merged-externally'],
  'lrq-closed': ['pr-closed-externally'],
  'lrq-handed-to-review': [],
};
const EXPECTED_STATUS = {
  'lrq-landed': 'completed',
  'lrq-refused': 'failed',
  'lrq-refused-then-landed': 'completed',
  'lrq-superseded': 'cancelled',
  'lrq-deferred': 'cancelled',
  'lrq-retryable': 'cancelled',
  'lrq-merged-elsewhere': 'cancelled',
  'lrq-closed': 'failed',
  'lrq-handed-to-review': 'cancelled',
};

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'qwv04-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJournal(root) {
  const dir = join(root, CLOSER_OUTCOME_SOURCE);
  mkdirSync(dir, { recursive: true });
  const byDay = {};
  let minute = 0;
  Object.entries(RECORDED).forEach(([launchRequestId, outcomes], index) => {
    const prNumber = 100 + index;
    const launchAt = `2026-11-10T10:${String(minute++).padStart(2, '0')}:00.000Z`;
    (byDay['2026-11-10'] ||= []).push({ schemaVersion: 1, kind: 'launch-terminal', repo: REPO, prNumber,
      headSha: HEAD, launchRequestId, terminalAt: launchAt, launchStatus: 'succeeded', outcome: null });
    outcomes.forEach((outcome, n) => {
      const day = n === 0 ? '2026-11-10' : '2026-11-11';
      (byDay[day] ||= []).push({ schemaVersion: 1, kind: 'lease-terminal', repo: REPO, prNumber,
        headSha: HEAD, launchRequestId, terminalAt: `${day}T11:${String(minute++).padStart(2, '0')}:00.000Z`,
        launchStatus: null, outcome });
    });
  });
  for (const [day, rows] of Object.entries(byDay)) {
    // A torn trailing row after an interrupted append is tolerated and counted.
    writeFileSync(join(dir, `${day}.jsonl`), `${rows.map(row => JSON.stringify(row)).join('\n')}\n{"kind":"lease-t`);
  }
}

// The losing store as it stood: every closer pass pinned to `failed`.
function seedPinnedFailedPasses(root) {
  Object.keys(RECORDED).forEach((launchRequestId, index) => {
    const key = { repo: REPO, prNumber: 100 + index, attemptNumber: 1, passKind: 'closer' };
    const metadata = { amaCloser: true, launchRequestId, terminalStatus: 'succeeded', merged: false };
    beginReviewerPass(root, { ...key, reviewerClass: 'hammer', startedAt: '2026-11-10T09:00:00.000Z', metadata });
    completeReviewerPass(root, { ...key, status: 'failed', endedAt: '2026-11-10T12:00:00.000Z', metadata,
      tokenUsage: { input: 10, output: 5 } });
  });
}

function closerRows(root) {
  const db = new Database(join(root, 'data', 'reviews.db'), { readonly: true });
  try {
    return db.prepare(`SELECT status, token_input, metadata_json FROM reviewer_passes
      WHERE pass_kind = 'closer' ORDER BY pr_number`).all()
      .map(row => ({ ...row, metadata: JSON.parse(row.metadata_json) }));
  } finally {
    db.close();
  }
}

test('outcome projection: succeeded is sticky; no verdict is cancelled; refusals fail', () => {
  for (const [launch, outcomes] of Object.entries(RECORDED)) {
    assert.equal(projectCloserOutcome(outcomes).status, EXPECTED_STATUS[launch], launch);
  }
  assert.deepEqual(projectCloserOutcome(['succeeded', 'failed-without-merge']),
    { status: 'completed', closerOutcome: 'succeeded' });
  assert.deepEqual(projectCloserOutcome([]), { status: 'cancelled', closerOutcome: null });
});

test('journal sorting excludes missing, non-string and invalid terminal timestamps', t => {
  const root = scratch(t);
  const dir = join(root, CLOSER_OUTCOME_SOURCE);
  mkdirSync(dir, { recursive: true });
  const row = { kind: 'lease-terminal', launchRequestId: 'lrq-sort', outcome: 'failed-without-merge' };
  const rows = [
    { ...row, terminalAt: '2026-11-10T12:00:00.000Z', outcome: 'deferred' },
    ...[undefined, null, 0, {}, '', 'not-a-time'].map(terminalAt => ({ ...row, terminalAt, outcome: 'succeeded' })),
    { ...row, terminalAt: '2026-11-10T11:00:00.000Z' },
    { ...row, launchRequestId: 'lrq-invalid-only', terminalAt: 'invalid', outcome: 'succeeded' },
  ];
  writeFileSync(join(dir, '2026-11-10.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
  const { outcomes } = readCloserLeaseOutcomes(root);
  assert.deepEqual(outcomes.get('lrq-sort'), {
    outcomes: ['failed-without-merge', 'deferred'], firstTerminalAt: '2026-11-10T11:00:00.000Z',
  });
  assert.equal(outcomes.has('lrq-invalid-only'), false);
  assert.deepEqual(projectCloserPassStatus(root, { launchRequestId: 'lrq-sort' }),
    { status: 'cancelled', closerOutcome: 'deferred' });
  const summary = summarizeCloserOutcomes(root, { since: '2026-11-01T00:00:00.000Z' });
  assert.equal(summary.launches, 1);
  assert.equal(summary.cancelled, 1);
  assert.equal(summary.completed, 0);
});

test('projection derives the same closer outcomes as the authority on recorded fixtures', t => {
  const root = scratch(t);
  writeJournal(root);
  seedPinnedFailedPasses(root);
  const since = '2026-11-01T00:00:00.000Z';
  const db = new Database(join(root, 'data', 'reviews.db'));
  const before = refreshCloserPassStatuses(db, root, { since, dryRun: true });
  assert.equal(before.updated, 0);
  assert.equal(closerRows(root).every(row => row.status === 'failed'), true, 'dry run writes nothing');
  const applied = refreshCloserPassStatuses(db, root, { since });
  const after = refreshCloserPassStatuses(db, root, { since, dryRun: true });
  db.close();
  assert.equal(applied.tornRows, 2);
  assert.equal(after.disagree.length, 0);
  assert.equal(after.agree, Object.keys(RECORDED).length);
  const rows = closerRows(root);
  for (const row of rows) {
    assert.equal(row.status, EXPECTED_STATUS[row.metadata.launchRequestId], row.metadata.launchRequestId);
    assert.equal(row.token_input, 10, 'tokens survive the projection');
  }
  // The authority's own counts equal the projected reviewer_passes counts.
  const summary = summarizeCloserOutcomes(root, { since });
  assert.equal(summary.source, 'data/ama-closer-outcomes');
  for (const status of ['completed', 'failed', 'cancelled']) {
    const launchesWithLease = rows.filter(row => RECORDED[row.metadata.launchRequestId].length);
    assert.equal(summary[status], launchesWithLease.filter(row => row.status === status).length, status);
  }
  assert.equal(summary.launches, Object.values(RECORDED).filter(list => list.length).length);
});

test('a lease-terminal journal append re-projects the launch pass it names', t => {
  const root = scratch(t);
  seedPinnedFailedPasses(root);
  assert.equal(projectCloserPassStatus(root, { launchRequestId: 'lrq-landed' }).status, 'cancelled');
  assert.equal(appendCloserOutcome(root, { repo: REPO, prNumber: 100, headSha: HEAD, lrqId: 'lrq-landed',
    status: 'terminal', terminalOutcome: 'succeeded', updatedAt: '2026-11-10T11:00:00.000Z' }, 'lease-terminal'), true);
  const rows = closerRows(root);
  assert.equal(rows[0].status, 'completed');
  assert.equal(rows[0].metadata.closerOutcome, 'succeeded');
  assert.equal(rows.slice(1).every(row => row.status === 'failed'), true, 'other launches untouched');
  // A later refusal on the same launch cannot erase the merge.
  appendCloserOutcome(root, { repo: REPO, prNumber: 100, headSha: HEAD, lrqId: 'lrq-landed',
    status: 'terminal', terminalOutcome: 'failed-without-merge', updatedAt: '2026-11-10T12:00:00.000Z' },
  'lease-terminal');
  assert.equal(closerRows(root)[0].status, 'completed');
});

test('malformed metadata and an unreadable journal never block recording or projection', t => {
  const root = scratch(t);
  seedPinnedFailedPasses(root);
  const db = new Database(join(root, 'data', 'reviews.db'));
  db.prepare(`UPDATE reviewer_passes SET metadata_json = '{not json' WHERE pr_number = 101`).run();
  assert.equal(refreshCloserPassStatuses(db, root, { launchRequestId: 'lrq-landed' }).agree, 0);
  db.close();
  writeFileSync(join(root, 'data', 'ama-closer-outcomes'), 'not a directory');
  assert.deepEqual(projectCloserPassStatus(root, { launchRequestId: 'lrq-landed' }),
    { status: 'cancelled', closerOutcome: null });
});

test('a lease-terminal append without reviews.db writes only the journal', t => {
  const root = scratch(t);
  assert.equal(appendCloserOutcome(root, { repo: REPO, prNumber: 1, headSha: HEAD, lrqId: 'lrq-x',
    status: 'terminal', terminalOutcome: 'succeeded', updatedAt: '2026-11-10T11:00:00.000Z' }, 'lease-terminal'), true);
  assert.deepEqual(readdirSync(join(root, 'data')), ['ama-closer-outcomes']);
});

test('closer-outcome-status reports the authority and is read-only unless --apply', t => {
  const root = scratch(t);
  writeJournal(root);
  seedPinnedFailedPasses(root);
  const nowMs = Date.parse('2026-11-12T00:00:00.000Z');
  const print = () => {};
  const report = closerOutcomeStatus(['--root-dir', root, '--since', '30d', '--json'], { nowMs, print });
  assert.equal(report.source, 'data/ama-closer-outcomes');
  assert.equal(report.completed, 2);
  assert.equal(report.reviewerPasses.updated, 0);
  assert.ok(report.reviewerPasses.disagree.length > 0);
  assert.equal(closerRows(root).every(row => row.status === 'failed'), true);
  const applied = closerOutcomeStatus(['--root-dir', root, '--since', '30d', '--apply'], { nowMs, print });
  assert.equal(applied.reviewerPasses.updated, report.reviewerPasses.disagree.length);
  assert.equal(closerOutcomeStatus(['--root-dir', root], { nowMs, print }).reviewerPasses.disagree.length, 0);
  assert.throws(() => closerOutcomeStatus(['--since', 'yesterday'], { nowMs, print }), /--since/);
});

test('closer-outcome-status defaults to its checkout from a foreign cwd and honors --root-dir', t => {
  const root = scratch(t);
  const override = scratch(t);
  writeJournal(root);
  seedPinnedFailedPasses(root);
  seedPinnedFailedPasses(override);
  // Install the real CLI in a disposable checkout so no production DB is read.
  mkdirSync(join(root, 'bin'));
  copyFileSync(new URL('../bin/closer-outcome-status.mjs', import.meta.url), join(root, 'bin', 'status.mjs'));
  for (const name of ['src', 'node_modules']) {
    symlinkSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(root, name), 'dir');
  }
  const invoke = args => {
    const result = spawnSync(process.execPath,
      [realpathSync(join(root, 'bin', 'status.mjs')), '--since', '2026-11-01T00:00:00.000Z', ...args],
      { cwd: override, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(invoke([]).completed, 2, 'uses the CLI checkout, even when cwd has another reviews.db');
  assert.equal(invoke(['--root-dir', override]).launches, 0, 'explicit override selects the other checkout');
});

test('no remaining writer of the losing store: closer pass status comes only from the projection', () => {
  const src = name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
  const dispatchCloser = src('ama/dispatch-closer.mjs');
  assert.doesNotMatch(dispatchCloser, /closerReviewerPassStatusForDispatchStatus/);
  // The pass records the authority's outcome, not a dispatch-side merge flag.
  for (const call of dispatchCloser.split('recordAmaCloserReviewerPassTokens({').slice(1)) {
    assert.doesNotMatch(call.slice(0, call.indexOf('});')), /\bmerged\b/);
  }
  assert.match(dispatchCloser, /status: projected\.status/);
  assert.doesNotMatch(dispatchCloser, /^\s+merged,$/m);
  // Every closer-kind pass write: the projected record, plus the token
  // backfill, which rewrites tokens and keeps the stored (projected) status.
  const writes = ['ama/dispatch-closer.mjs', 'reviewer-pass-tokens.mjs', 'review-pipeline-health.mjs',
    'ama/closer-pass-attempt.mjs']
    .flatMap(name => (src(name).match(/passKind: 'closer'/g) || []).map(() => name));
  assert.deepEqual(writes, ['ama/dispatch-closer.mjs', 'ama/dispatch-closer.mjs', 'reviewer-pass-tokens.mjs']);
  assert.match(src('reviewer-pass-tokens.mjs'),
    /passKind: 'closer',\s+status: PASS_STATUSES\.has\(row\.status\) \? row\.status : 'completed'/);
  assert.doesNotMatch(src('review-pipeline-health.mjs'), /metadata\?\.merged/);
});
