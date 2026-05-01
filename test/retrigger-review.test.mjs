import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ensureReviewStateSchema,
  openReviewStateDb,
} from '../src/review-state.mjs';

import {
  parseArgs,
  main,
  UsageError,
} from '../src/retrigger-review.mjs';

// Capture-stream helper so main() can be invoked under test without writing
// to the real process stdout/stderr.
function makeCaptureStream() {
  const chunks = [];
  return {
    write(chunk) { chunks.push(String(chunk)); return true; },
    text() { return chunks.join(''); },
  };
}

function insertReviewRow(rootDir, overrides = {}) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    db.prepare(
      'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket, review_status, review_attempts, last_attempted_at, posted_at, failed_at, failure_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      overrides.repo || 'laceyenterprises/adversarial-review',
      overrides.prNumber || 42,
      overrides.reviewedAt || '2026-04-24T12:00:00.000Z',
      overrides.reviewer || 'codex',
      overrides.prState || 'open',
      overrides.linearTicket || null,
      overrides.reviewStatus || 'posted',
      overrides.reviewAttempts ?? 1,
      overrides.lastAttemptedAt ?? '2026-04-24T12:05:00.000Z',
      overrides.postedAt ?? '2026-04-24T12:06:00.000Z',
      overrides.failedAt ?? null,
      overrides.failureMessage ?? null
    );
  } finally {
    db.close();
  }
}

// ── parseArgs unit coverage ─────────────────────────────────────────────────

test('parseArgs accepts inline --reason and parses pr as integer', () => {
  const { values, reasonSource } = parseArgs([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '99',
    '--reason', 'looks good',
  ]);
  assert.equal(values.repo, 'laceyenterprises/agent-os');
  assert.equal(values.pr, 99);
  assert.equal(reasonSource, 'reason');
});

test('parseArgs accepts --reason-file', () => {
  const { reasonSource } = parseArgs([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '99',
    '--reason-file', '/tmp/x',
  ]);
  assert.equal(reasonSource, 'reason-file');
});

test('parseArgs accepts --reason-stdin', () => {
  const { reasonSource } = parseArgs([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '99',
    '--reason-stdin',
  ]);
  assert.equal(reasonSource, 'reason-stdin');
});

test('parseArgs rejects missing --repo', () => {
  assert.throws(
    () => parseArgs(['--pr', '99', '--reason', 'x']),
    UsageError
  );
});

test('parseArgs rejects missing --pr', () => {
  assert.throws(
    () => parseArgs(['--repo', 'a/b', '--reason', 'x']),
    UsageError
  );
});

test('parseArgs rejects non-integer --pr', () => {
  assert.throws(
    () => parseArgs(['--repo', 'a/b', '--pr', 'abc', '--reason', 'x']),
    /positive integer/
  );
});

test('parseArgs rejects --pr=0 (positive-integer check)', () => {
  assert.throws(
    () => parseArgs(['--repo', 'a/b', '--pr', '0', '--reason', 'x']),
    /positive integer/
  );
});

test('parseArgs rejects --pr with a leading dash (caught earlier by node:util)', () => {
  // node:util parseArgs raises an "argument is ambiguous" error when an
  // option value starts with `-`, before reaching our positive-integer
  // check. Either path is fine — what matters is that this argv shape
  // does not slip through as a successful parse.
  assert.throws(
    () => parseArgs(['--repo', 'a/b', '--pr', '-5', '--reason', 'x']),
    UsageError
  );
});

test('parseArgs rejects no reason source', () => {
  assert.throws(
    () => parseArgs(['--repo', 'a/b', '--pr', '99']),
    /one of --reason/
  );
});

test('parseArgs rejects multiple reason sources', () => {
  assert.throws(
    () => parseArgs([
      '--repo', 'a/b',
      '--pr', '99',
      '--reason', 'inline',
      '--reason-file', '/tmp/x',
    ]),
    /exactly one of/
  );
});

test('parseArgs --help short-circuits without requiring repo/pr', () => {
  const result = parseArgs(['--help']);
  assert.equal(result.values.help, true);
});

// ── main() integration coverage (uses real db via review-state.mjs) ─────────

test('main triggers a rereview for a posted PR and exits 0', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-test-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });

  const out = makeCaptureStream();
  const err = makeCaptureStream();
  const rc = main(
    [
      '--repo', 'laceyenterprises/adversarial-review',
      '--pr', '42',
      '--reason', 'second pass landed',
      '--root-dir', rootDir,
    ],
    { stdout: out, stderr: err }
  );

  assert.equal(rc, 0);
  assert.match(out.text(), /triggered/);
  assert.equal(err.text(), '');

  // Confirm db side effect — review_status flipped, posted_at cleared.
  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare(
      'SELECT review_status, posted_at, rereview_requested_at, rereview_reason FROM reviewed_prs WHERE pr_number = 42'
    ).get();
    assert.equal(row.review_status, 'pending');
    assert.equal(row.posted_at, null);
    assert.ok(row.rereview_requested_at);
    assert.equal(row.rereview_reason, 'second pass landed');
  } finally {
    db.close();
  }
});

test('main returns 0 with already-pending message when row is already pending', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-test-'));
  insertReviewRow(rootDir, { reviewStatus: 'pending' });

  const out = makeCaptureStream();
  const err = makeCaptureStream();
  const rc = main(
    [
      '--repo', 'laceyenterprises/adversarial-review',
      '--pr', '42',
      '--reason', 'noop expected',
      '--root-dir', rootDir,
    ],
    { stdout: out, stderr: err }
  );

  assert.equal(rc, 0);
  assert.match(out.text(), /already-pending/);
  assert.equal(err.text(), '');
});

test('main returns 1 with blocked message when review row is missing', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-test-'));

  // Schema present but no row inserted.
  const db = openReviewStateDb(rootDir);
  try { ensureReviewStateSchema(db); } finally { db.close(); }

  const out = makeCaptureStream();
  const err = makeCaptureStream();
  const rc = main(
    [
      '--repo', 'laceyenterprises/adversarial-review',
      '--pr', '42',
      '--reason', 'whatever',
      '--root-dir', rootDir,
    ],
    { stdout: out, stderr: err }
  );

  assert.equal(rc, 1);
  assert.match(err.text(), /blocked.*review-row-missing/);
});

test('main returns 1 when PR is no longer open (merged)', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-test-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted', prState: 'merged' });

  const err = makeCaptureStream();
  const rc = main(
    [
      '--repo', 'laceyenterprises/adversarial-review',
      '--pr', '42',
      '--reason', 'too late',
      '--root-dir', rootDir,
    ],
    { stdout: makeCaptureStream(), stderr: err }
  );

  assert.equal(rc, 1);
  assert.match(err.text(), /pr-not-open/);
});

test('main returns 1 when review is malformed-title-terminal', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-test-'));
  insertReviewRow(rootDir, { reviewStatus: 'malformed' });

  const err = makeCaptureStream();
  const rc = main(
    [
      '--repo', 'laceyenterprises/adversarial-review',
      '--pr', '42',
      '--reason', 'fix the title first',
      '--root-dir', rootDir,
    ],
    { stdout: makeCaptureStream(), stderr: err }
  );

  assert.equal(rc, 1);
  assert.match(err.text(), /malformed-title-terminal/);
});

test('main returns 2 on usage error', () => {
  const out = makeCaptureStream();
  const err = makeCaptureStream();
  const rc = main(['--repo', 'a/b'], { stdout: out, stderr: err });
  assert.equal(rc, 2);
  assert.match(err.text(), /^error:/);
});

test('main reads --reason-file', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-test-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });

  const reasonPath = path.join(rootDir, 'reason.md');
  writeFileSync(reasonPath, 'multi\nline\nreason text\n', 'utf-8');

  const out = makeCaptureStream();
  const rc = main(
    [
      '--repo', 'laceyenterprises/adversarial-review',
      '--pr', '42',
      '--reason-file', reasonPath,
      '--root-dir', rootDir,
    ],
    { stdout: out, stderr: makeCaptureStream() }
  );

  assert.equal(rc, 0);

  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare(
      'SELECT rereview_reason FROM reviewed_prs WHERE pr_number = 42'
    ).get();
    assert.equal(row.rereview_reason, 'multi\nline\nreason text\n');
  } finally {
    db.close();
  }
});

test('main returns 3 when --reason-file is unreadable', () => {
  const out = makeCaptureStream();
  const err = makeCaptureStream();
  const rc = main(
    [
      '--repo', 'laceyenterprises/adversarial-review',
      '--pr', '42',
      '--reason-file', '/tmp/this-file-does-not-exist-987654321',
    ],
    { stdout: out, stderr: err }
  );
  assert.equal(rc, 3);
  assert.match(err.text(), /could not read reason/);
});

test('main reads --reason-stdin via injected reader', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-test-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });

  const out = makeCaptureStream();
  const rc = main(
    [
      '--repo', 'laceyenterprises/adversarial-review',
      '--pr', '42',
      '--reason-stdin',
      '--root-dir', rootDir,
    ],
    {
      stdout: out,
      stderr: makeCaptureStream(),
      stdinReader: () => 'piped reason\n',
    }
  );

  assert.equal(rc, 0);

  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare(
      'SELECT rereview_reason FROM reviewed_prs WHERE pr_number = 42'
    ).get();
    assert.equal(row.rereview_reason, 'piped reason\n');
  } finally {
    db.close();
  }
});

test('main rejects empty reason from any source', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-test-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });

  const err = makeCaptureStream();
  const rc = main(
    [
      '--repo', 'laceyenterprises/adversarial-review',
      '--pr', '42',
      '--reason-stdin',
      '--root-dir', rootDir,
    ],
    {
      stdout: makeCaptureStream(),
      stderr: err,
      stdinReader: () => '   \n  \t\n',
    }
  );

  assert.equal(rc, 3);
  assert.match(err.text(), /reason is empty/);
});

test('main with --quiet suppresses informational output but preserves exit code', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-test-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });

  const out = makeCaptureStream();
  const rc = main(
    [
      '--repo', 'laceyenterprises/adversarial-review',
      '--pr', '42',
      '--reason', 'quiet mode',
      '--root-dir', rootDir,
      '--quiet',
    ],
    { stdout: out, stderr: makeCaptureStream() }
  );

  assert.equal(rc, 0);
  assert.equal(out.text(), '');
});

// ── PR #13 round-2 review fixes ─────────────────────────────────────────────

test('parseArgs accepts --allow-failed-reset (default false)', () => {
  const { values: defaultValues } = parseArgs([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '99',
    '--reason', 'x',
  ]);
  assert.equal(defaultValues['allow-failed-reset'], false);

  const { values: optedIn } = parseArgs([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '99',
    '--reason', 'x',
    '--allow-failed-reset',
  ]);
  assert.equal(optedIn['allow-failed-reset'], true);
});

test('main refuses review_status=failed without --allow-failed-reset and preserves failure evidence', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-test-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'failed',
    failedAt: '2026-04-30T22:11:33.000Z',
    failureMessage: 'oauth token expired',
    postedAt: null,
  });

  const err = makeCaptureStream();
  const rc = main(
    [
      '--repo', 'laceyenterprises/adversarial-review',
      '--pr', '42',
      '--reason', 'fix it',
      '--root-dir', rootDir,
    ],
    { stdout: makeCaptureStream(), stderr: err }
  );

  assert.equal(rc, 1, 'should be blocked');
  assert.match(err.text(), /failed-status-needs-explicit-allow/);
  assert.match(err.text(), /--allow-failed-reset/);

  // Diagnostic evidence MUST still be on disk — that's the whole point.
  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare(
      'SELECT review_status, failed_at, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/adversarial-review', 42);
    assert.equal(row.review_status, 'failed', 'status untouched');
    assert.equal(row.failed_at, '2026-04-30T22:11:33.000Z', 'failed_at preserved');
    assert.equal(row.failure_message, 'oauth token expired', 'failure_message preserved');
  } finally {
    db.close();
  }
});

test('main accepts review_status=failed when --allow-failed-reset is set (matches existing behavior)', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-test-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'failed',
    failedAt: '2026-04-30T22:11:33.000Z',
    failureMessage: 'oauth token expired',
    postedAt: null,
  });

  const out = makeCaptureStream();
  const rc = main(
    [
      '--repo', 'laceyenterprises/adversarial-review',
      '--pr', '42',
      '--reason', 'fixed token; clean rerun',
      '--root-dir', rootDir,
      '--allow-failed-reset',
    ],
    { stdout: out, stderr: makeCaptureStream() }
  );

  assert.equal(rc, 0, 'should trigger');
  assert.match(out.text(), /triggered/);

  // With the explicit override, the helper's reset behavior applies and
  // failure evidence is intentionally cleared.
  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare(
      'SELECT review_status, failed_at, failure_message, rereview_reason FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/adversarial-review', 42);
    assert.equal(row.review_status, 'pending');
    assert.equal(row.failed_at, null);
    assert.equal(row.failure_message, null);
    assert.equal(row.rereview_reason, 'fixed token; clean rerun');
  } finally {
    db.close();
  }
});

test('main returns 4 with concise stderr (no stack trace) when rereview throws', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-test-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });

  const err = makeCaptureStream();
  const rc = main(
    [
      '--repo', 'laceyenterprises/adversarial-review',
      '--pr', '42',
      '--reason', 'simulate runtime failure',
      '--root-dir', rootDir,
    ],
    {
      stdout: makeCaptureStream(),
      stderr: err,
      rereview: () => { throw new Error('database is locked'); },
    }
  );

  assert.equal(rc, 4);
  const text = err.text();
  assert.match(text, /rereview failed: database is locked/);
  // No 'at <function>' frames — the operator should see a clean message,
  // not a Node stack trace.
  assert.doesNotMatch(text, / at /);
});

test('main returns 4 when readReviewRow throws (e.g. unreadable --root-dir)', () => {
  const err = makeCaptureStream();
  const rc = main(
    [
      '--repo', 'laceyenterprises/adversarial-review',
      '--pr', '42',
      '--reason', 'simulate bad root-dir',
    ],
    {
      stdout: makeCaptureStream(),
      stderr: err,
      readReviewRow: () => { throw new Error('ENOENT: no such file or directory'); },
    }
  );

  assert.equal(rc, 4);
  assert.match(err.text(), /could not read review state: ENOENT/);
  assert.doesNotMatch(err.text(), / at /);
});

test('main returns 4 with real broken --root-dir (subprocess-style: passing /dev/null)', () => {
  // The reviewer's repro: --root-dir /dev/null. openReviewStateDb does
  // mkdirSync(join(rootDir, 'data'), {recursive:true}) which fails with
  // ENOTDIR because /dev/null is a character device, not a directory.
  const err = makeCaptureStream();
  const rc = main(
    [
      '--repo', 'laceyenterprises/adversarial-review',
      '--pr', '42',
      '--reason', 'broken root',
      '--root-dir', '/dev/null',
    ],
    { stdout: makeCaptureStream(), stderr: err }
  );

  assert.equal(rc, 4, 'broken --root-dir must produce a deterministic exit, not a stack trace');
  assert.match(err.text(), /could not read review state/);
  assert.doesNotMatch(err.text(), / at /);
});
