import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { main, parseArgs } from '../src/retrigger-review.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { createFollowUpJob, getFollowUpJobDir, writeFollowUpJob } from '../src/follow-up-jobs.mjs';

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
      'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, posted_at, failed_at, failure_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      overrides.repo || 'laceyenterprises/agent-os',
      overrides.prNumber || 238,
      '2026-05-05T04:00:00.000Z',
      'codex',
      overrides.prState || 'open',
      overrides.reviewStatus || 'posted',
      1,
      '2026-05-05T04:00:00.000Z',
      overrides.failedAt || null,
      overrides.failureMessage || null,
    );
  } finally {
    db.close();
  }
}

function makeJob(rootDir, overrides = {}) {
  const result = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    reviewerModel: 'claude',
    reviewBody: '## Summary\nsummary',
    reviewPostedAt: '2026-05-05T04:00:00.000Z',
    critical: true,
    maxRemediationRounds: 1,
  });
  const job = {
    ...result.job,
    ...overrides,
    remediationPlan: {
      ...result.job.remediationPlan,
      ...(overrides.remediationPlan || {}),
    },
  };
  writeFollowUpJob(result.jobPath, job);
  return { jobPath: result.jobPath, job };
}

test('parseArgs defaults --bump-budget to 1', () => {
  const { values } = parseArgs([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
  ]);
  assert.equal(values.bumpBudget, 1);
});

test('parseArgs accepts audit-root-dir and allow-failed-reset', () => {
  const { values } = parseArgs([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--audit-root-dir', '/tmp/audit-root',
    '--allow-failed-reset',
  ]);
  assert.equal(values['audit-root-dir'], '/tmp/audit-root');
  assert.equal(values['allow-failed-reset'], true);
});

test('retrigger-review rejects legacy --hq-root', () => {
  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--hq-root', '/tmp/hq-root',
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 2);
  assert.match(err.text(), /--hq-root is no longer supported/);
});

test('parseArgs rejects mutually exclusive budget flags', () => {
  assert.throws(
    () => parseArgs([
      '--repo', 'laceyenterprises/agent-os',
      '--pr', '238',
      '--reason', 'retry',
      '--bump-budget', '2',
      '--no-bump-budget',
    ]),
    /mutually exclusive/
  );
});

test('parseArgs rejects missing reason source', () => {
  assert.throws(
    () => parseArgs([
      '--repo', 'laceyenterprises/agent-os',
      '--pr', '238',
    ]),
    /pass exactly one of/
  );
});

test('parseArgs rejects non-positive bump budgets', () => {
  assert.throws(
    () => parseArgs([
      '--repo', 'laceyenterprises/agent-os',
      '--pr', '238',
      '--reason', 'retry',
      '--bump-budget', '0',
    ]),
    /positive integer/
  );
});

test('retrigger-review treats pending review rows as already-pending success and still bumps budget', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'pending' });
  const { jobPath } = makeJob(rootDir, {
    status: 'completed',
    completedAt: '2026-05-05T04:05:00.000Z',
    reReview: { requested: true },
  });

  const out = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  assert.equal(JSON.parse(out.text()).outcome, 'already-pending+bumped');
  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(job.remediationPlan.maxRounds, 2);
});

test('retrigger-review bumps the terminal job budget and resets review status', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });
  const { jobPath } = makeJob(rootDir, {
    status: 'completed',
    completedAt: '2026-05-05T04:05:00.000Z',
    reReview: { requested: true },
  });

  const out = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'substantially rewritten',
    '--root-dir', rootDir,
    '--audit-root-dir', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare('SELECT review_status FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
      .get('laceyenterprises/agent-os', 238);
    assert.equal(row.review_status, 'pending');
  } finally {
    db.close();
  }

  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(job.remediationPlan.maxRounds, 2);
  assert.equal(JSON.parse(out.text()).outcome, 'triggered+bumped');
});

test('retrigger-review refuses active follow-up jobs when bumping is enabled', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });
  makeJob(rootDir, { status: 'pending' });

  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
    '--audit-root-dir', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 1);
  assert.match(err.text(), /refused:job-active/);
});

test('retrigger-review preserves failed-review evidence unless allow-failed-reset is set', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'failed',
    failedAt: '2026-05-05T04:06:00.000Z',
    failureMessage: 'reviewer crashed',
  });

  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 1);
  assert.match(err.text(), /watcher already retries failed review rows automatically/i);
  assert.match(err.text(), /--allow-failed-reset/);
});

test('retrigger-review allows failed reset when explicitly requested', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'failed',
    failedAt: '2026-05-05T04:06:00.000Z',
    failureMessage: 'reviewer crashed',
  });

  const out = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--allow-failed-reset',
    '--root-dir', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  assert.equal(JSON.parse(out.text()).outcome, 'triggered:no-job');
});

test('retrigger-review allows failed-orphan reset when explicitly requested', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'failed-orphan',
    failedAt: '2026-05-05T04:06:00.000Z',
    failureMessage: 'watcher restarted while reviewing',
  });

  const err = makeCaptureStream();
  const blocked = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'verified no orphan review posted',
    '--root-dir', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(blocked, 1);
  assert.match(err.text(), /failed-orphan/);

  const out = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'verified no orphan review posted',
    '--allow-failed-reset',
    '--root-dir', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  assert.equal(JSON.parse(out.text()).outcome, 'triggered:no-job');

  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare('SELECT review_status, failed_at, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
      .get('laceyenterprises/agent-os', 238);
    assert.equal(row.review_status, 'pending');
    assert.equal(row.failed_at, null);
    assert.equal(row.failure_message, null);
  } finally {
    db.close();
  }
});

test('retrigger-review explains reviewing recovery path', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'reviewing' });

  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 1);
  assert.match(err.text(), /duplicate GitHub review/i);
  assert.match(err.text(), /reconcileOrphanedReviewing/);
});

test('retrigger-review returns runtime exit code when a refusal-path audit append fails', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'reviewing' });
  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
    appendAuditRow: () => {
      throw new Error('disk full');
    },
  });

  assert.equal(rc, 4);
  assert.match(err.text(), /error: could not append operator mutation audit row: disk full/);
  assert.doesNotMatch(err.text(), /\n\s+at\s/);
});

test('retrigger-review keeps reviewing rows blocked even with --allow-failed-reset', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'reviewing' });

  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--allow-failed-reset',
    '--root-dir', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 1);
  assert.match(err.text(), /reviewing/);
});

test('retrigger-review skips the budget bump when no follow-up job exists', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });
  mkdirSync(getFollowUpJobDir(rootDir, 'pending'), { recursive: true });

  const out = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
    '--audit-root-dir', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  const row = JSON.parse(out.text());
  assert.equal(row.outcome, 'triggered:no-job');
  assert.equal(row.priorMaxRounds, null);
  assert.equal(row.newMaxRounds, null);
});

test('retrigger-review returns reason-input exit code for missing reason content', () => {
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', '   ',
  ], { stdout: makeCaptureStream(), stderr: makeCaptureStream() });

  assert.equal(rc, 3);
});

test('retrigger-review reads reason from file', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });
  const reasonFile = path.join(rootDir, 'reason.txt');
  writeFileSync(reasonFile, 'from file\n', 'utf8');

  const out = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason-file', reasonFile,
    '--root-dir', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  assert.equal(JSON.parse(out.text()).reason, 'from file\n');
});

test('retrigger-review reads --reason-stdin via injected reader', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });

  const out = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason-stdin',
    '--root-dir', rootDir,
  ], {
    stdout: out,
    stderr: makeCaptureStream(),
    stdinReader: () => 'from stdin\n',
  });

  assert.equal(rc, 0);
  assert.equal(JSON.parse(out.text()).reason, 'from stdin\n');
});

test('retrigger-review --quiet suppresses informational output', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });

  const out = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--quiet',
    '--root-dir', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  assert.equal(out.text(), '');
});

test('retrigger-review writes the audit ledger under data/operator-mutations by default', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });

  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
  ], { stdout: makeCaptureStream(), stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  assert.equal(existsSync(path.join(rootDir, 'data', 'operator-mutations')), true);
});

test('retrigger-review re-evaluates retries after a refused row with the same idempotency key', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'reviewing' });
  const args = [
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--idempotency-key', 'shared-key',
    '--root-dir', rootDir,
  ];

  const firstErr = makeCaptureStream();
  assert.equal(main(args, { stdout: makeCaptureStream(), stderr: firstErr }), 1);
  assert.match(firstErr.text(), /reviewing/);

  const db = openReviewStateDb(rootDir);
  try {
    db.prepare('UPDATE reviewed_prs SET review_status = ? WHERE repo = ? AND pr_number = ?')
      .run('posted', 'laceyenterprises/agent-os', 238);
  } finally {
    db.close();
  }

  const out = makeCaptureStream();
  const secondRc = main(args, { stdout: out, stderr: makeCaptureStream() });
  assert.equal(secondRc, 0);
  assert.equal(JSON.parse(out.text()).outcome, 'triggered:no-job');
});

test('retrigger-review returns runtime exit code with concise stderr when rereview throws', () => {
  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
    readReviewRow: () => ({
      repo: 'laceyenterprises/agent-os',
      pr_number: 238,
      pr_state: 'open',
      review_status: 'posted',
    }),
    rereview: () => {
      throw new Error('boom');
    },
  });

  assert.equal(rc, 4);
  assert.match(err.text(), /error: rereview failed: boom/);
  assert.doesNotMatch(err.text(), /Error: boom/);
  assert.doesNotMatch(err.text(), /\n\s+at\s/);
});

test('retrigger-review returns runtime exit code with concise stderr when terminal audit append fails after rereview succeeds', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });

  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
    appendAuditRow: () => {
      throw new Error('disk full');
    },
  });

  assert.equal(rc, 4);
  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare('SELECT review_status FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
      .get('laceyenterprises/agent-os', 238);
    assert.equal(row.review_status, 'pending');
  } finally {
    db.close();
  }
  assert.match(err.text(), /error: could not append operator mutation audit row: disk full/);
  assert.doesNotMatch(err.text(), /Error: disk full/);
  assert.doesNotMatch(err.text(), /\n\s+at\s/);
});

test('retrigger-review maps idempotency mismatches to usage and writes a refusal row', () => {
  const rows = [];
  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
    findAuditRow: () => ({
      idempotencyKey: 'shared-key',
      verb: 'hq.adversarial.retrigger-review',
      repo: 'laceyenterprises/agent-os',
      pr: 238,
      reason: 'different reason',
      outcome: 'triggered',
    }),
    appendAuditRow: (_rootDir, row) => {
      rows.push(row);
    },
  });

  assert.equal(rc, 2);
  assert.match(err.text(), /refused:idempotency-mismatch/);
  assert.equal(rows.at(-1)?.outcome, 'refused:idempotency-mismatch');
});

test('retrigger-review returns runtime exit code when readReviewRow throws', () => {
  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
    readReviewRow: () => {
      throw new Error('db unavailable');
    },
  });

  assert.equal(rc, 4);
  assert.match(err.text(), /could not read review state: db unavailable/);
});

test('retrigger-review returns runtime exit code with broken root-dir', () => {
  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', '/dev/null',
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
  });

  assert.equal(rc, 4);
  assert.match(err.text(), /could not read review state:/);
  assert.doesNotMatch(err.text(), /\n\s+at\s/);
});

test('retrigger-review help documents structured usage and exit codes', () => {
  const out = makeCaptureStream();
  const rc = main(['--help'], {
    stdout: out,
    stderr: makeCaptureStream(),
  });

  assert.equal(rc, 0);
  assert.match(out.text(), /Required:/);
  assert.match(out.text(), /Optional:/);
  assert.match(out.text(), /Exit codes:/);
  assert.match(out.text(), /--allow-failed-reset/);
});

test('retrigger-review refuses unknown review statuses by default', () => {
  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
    readReviewRow: () => ({
      repo: 'laceyenterprises/agent-os',
      pr_number: 238,
      pr_state: 'open',
      review_status: 'orphaned',
    }),
  });

  assert.equal(rc, 1);
  assert.match(err.text(), /unknown-status:orphaned/);
});
