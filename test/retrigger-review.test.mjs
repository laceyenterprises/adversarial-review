import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  main,
  normalizeOperatorRetriggerReason,
  parseArgs,
  waitForReviewerExit,
} from '../src/retrigger-review.mjs';
import {
  ensureReviewStateSchema,
  forceResetReviewToPending,
  openReviewStateDb,
} from '../src/review-state.mjs';
import { createFollowUpJob, getFollowUpJobDir, writeFollowUpJob } from '../src/follow-up-jobs.mjs';
import { isExplicitOperatorReviewRetrigger } from '../src/first-pass-review-suppression.mjs';

function makeCaptureStream() {
  const chunks = [];
  return {
    write(chunk) { chunks.push(String(chunk)); return true; },
    text() { return chunks.join(''); },
  };
}

test('reviewer exit wait probes through the injected process-kill seam', async () => {
  const probes = [];
  let alive = true;

  const result = await waitForReviewerExit({ target: { id: 8123 } }, {
    waitMs: 10,
    pollMs: 1,
    processKill: (pid, signal) => {
      probes.push([pid, signal]);
      if (alive) {
        alive = false;
        return;
      }
      const error = new Error('gone');
      error.code = 'ESRCH';
      throw error;
    },
    sleep: async () => {},
  });

  assert.deepEqual(probes, [[-8123, 0], [-8123, 0]]);
  assert.deepEqual(result, { checked: true, exited: true, pgid: 8123 });
});

function insertReviewRow(rootDir, overrides = {}) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    db.prepare(
      `INSERT INTO reviewed_prs (
        repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts,
        posted_at, failed_at, failure_message, revision_ref, reviewer_session_uuid,
        reviewer_pgid, reviewer_started_at, reviewer_head_sha
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      overrides.revisionRef || 'head-current-238',
      overrides.reviewerSessionUuid || null,
      overrides.reviewerPgid ?? null,
      overrides.reviewerStartedAt || null,
      overrides.reviewerHeadSha || null,
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

test('parseArgs defaults --bump-budget to 1', async () => {
  const { values } = parseArgs([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
  ]);
  assert.equal(values.bumpBudget, 1);
});

test('parseArgs: --exact-head-now defaults to NO budget bump (#4921)', async () => {
  // An exact-head-now retrigger is an operator refresh of the CURRENT head, not
  // a new remediation round — it must not inflate maxRounds, or the budget never
  // exhausts and a non-converging PR stalls open forever.
  const { values } = parseArgs([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '4921',
    '--reason', 'review this exact head now',
    '--exact-head-now',
  ]);
  assert.equal(values.bumpBudget, 0);
});

test('parseArgs: --exact-head-now with explicit --bump-budget still bumps', async () => {
  const { values } = parseArgs([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '4921',
    '--reason', 'review this head now and grant one more round',
    '--exact-head-now',
    '--bump-budget', '2',
  ]);
  assert.equal(values.bumpBudget, 2);
});

test('parseArgs accepts audit-root-dir and allow-failed-reset', async () => {
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

test('parseArgs accepts exact-head recovery flags', async () => {
  const { values } = parseArgs([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--exact-head-now',
    '--cancel-active-review',
  ]);
  assert.equal(values['exact-head-now'], true);
  assert.equal(values['cancel-active-review'], true);
});

test('parseArgs rejects active-review recovery flags without exact-head-now', async () => {
  assert.throws(
    () => parseArgs([
      '--repo', 'laceyenterprises/agent-os',
      '--pr', '238',
      '--reason', 'retry',
      '--cancel-active-review',
    ]),
    /require --exact-head-now/
  );
});

test('normalizeOperatorRetriggerReason stores a canonical prefix', async () => {
  assert.equal(
    normalizeOperatorRetriggerReason('retry after remediation'),
    'retrigger-review: retry after remediation',
  );
  assert.equal(
    normalizeOperatorRetriggerReason('ReTrigger-Review: retry after remediation'),
    'retrigger-review: retry after remediation',
  );
  assert.equal(
    normalizeOperatorRetriggerReason('Please retrigger-review after remediation'),
    'retrigger-review: Please retrigger-review after remediation',
  );
  assert.equal(
    normalizeOperatorRetriggerReason(''),
    'retrigger-review: operator requested re-review',
  );
  assert.equal(
    normalizeOperatorRetriggerReason('retrigger-review:   '),
    'retrigger-review: operator requested re-review',
  );
});

test('retrigger-review rejects legacy --hq-root', async () => {
  const err = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--hq-root', '/tmp/hq-root',
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 2);
  assert.match(err.text(), /--hq-root is no longer supported/);
});

test('parseArgs rejects mutually exclusive budget flags', async () => {
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

test('parseArgs rejects missing reason source', async () => {
  assert.throws(
    () => parseArgs([
      '--repo', 'laceyenterprises/agent-os',
      '--pr', '238',
    ]),
    /pass exactly one of/
  );
});

test('parseArgs rejects non-positive bump budgets', async () => {
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

test('retrigger-review treats pending review rows as already-pending success and still bumps budget', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'pending' });
  const { jobPath } = makeJob(rootDir, {
    status: 'completed',
    completedAt: '2026-05-05T04:05:00.000Z',
    reReview: { requested: true },
  });

  const out = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  assert.equal(JSON.parse(out.text()).outcome, 'already-pending+bumped');
  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(job.remediationPlan.maxRounds, 2);
  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare(
      'SELECT review_status, rereview_requested_at, rereview_reason FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/agent-os', 238);
    assert.equal(row.review_status, 'pending');
    assert.match(row.rereview_reason, /^retrigger-review: retry$/);
    assert.equal(isExplicitOperatorReviewRetrigger(row), true);
  } finally {
    db.close();
  }
});

test('retrigger-review bumps pending timestamp even when explicit reason is unchanged', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'pending' });
  const previousRequestedAt = '2026-05-05T04:00:00.000Z';
  const db = openReviewStateDb(rootDir);
  try {
    db.prepare(
      `UPDATE reviewed_prs
          SET rereview_requested_at = ?,
              rereview_reason = ?
        WHERE repo = ?
          AND pr_number = ?`
    ).run(
      previousRequestedAt,
      'retrigger-review: retry',
      'laceyenterprises/agent-os',
      238,
    );
  } finally {
    db.close();
  }

  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
    '--no-bump-budget',
  ], { stdout: makeCaptureStream(), stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  const readDb = openReviewStateDb(rootDir);
  try {
    const row = readDb.prepare(
      'SELECT rereview_requested_at, rereview_reason FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/agent-os', 238);
    assert.notEqual(row.rereview_requested_at, previousRequestedAt);
    assert.equal(row.rereview_reason, 'retrigger-review: retry');
    assert.equal(isExplicitOperatorReviewRetrigger(row), true);
  } finally {
    readDb.close();
  }
});

test('retrigger-review bumps the terminal job budget and resets review status', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });
  const { jobPath } = makeJob(rootDir, {
    status: 'completed',
    completedAt: '2026-05-05T04:05:00.000Z',
    reReview: { requested: true },
  });

  const out = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'substantially rewritten',
    '--root-dir', rootDir,
    '--audit-root-dir', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare(
      'SELECT review_status, rereview_requested_at, rereview_reason FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    )
      .get('laceyenterprises/agent-os', 238);
    assert.equal(row.review_status, 'pending');
    assert.match(row.rereview_reason, /^retrigger-review: substantially rewritten$/);
    assert.equal(isExplicitOperatorReviewRetrigger(row), true);
  } finally {
    db.close();
  }

  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(job.remediationPlan.maxRounds, 2);
  assert.equal(JSON.parse(out.text()).outcome, 'triggered+bumped');
});

test('retrigger-review exact-head-now leaves the explicit operator marker used for one-shot hard-review-ceiling bypass', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });

  const out = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'final exact-head recovery',
    '--exact-head-now',
    '--no-bump-budget',
    '--root-dir', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  const auditRow = JSON.parse(out.text());
  assert.equal(auditRow.exactHeadNow, true);
  assert.equal(auditRow.outcome, 'triggered');
  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare(
      'SELECT review_status, rereview_reason FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/agent-os', 238);
    assert.equal(row.review_status, 'pending');
    assert.match(row.rereview_reason, /^retrigger-review: final exact-head recovery$/);
  } finally {
    db.close();
  }
});

test('retrigger-review preserves pending-upstream evidence without exact-head-now', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'pending-upstream',
    failedAt: '2026-05-05T04:06:00.000Z',
    failureMessage: 'review provider unavailable',
  });

  const err = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry after provider recovery',
    '--no-bump-budget',
    '--root-dir', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 1);
  assert.match(err.text(), /pending-upstream/);
  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare(
      'SELECT review_status, failed_at, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/agent-os', 238);
    assert.equal(row.review_status, 'pending-upstream');
    assert.equal(row.failed_at, '2026-05-05T04:06:00.000Z');
    assert.equal(row.failure_message, 'review provider unavailable');
  } finally {
    db.close();
  }
});

test('retrigger-review exact-head-now re-arms pending-upstream review', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'pending-upstream',
    failedAt: '2026-05-05T04:06:00.000Z',
    failureMessage: 'review provider unavailable',
  });

  const out = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry exact head after provider recovery',
    '--exact-head-now',
    '--no-bump-budget',
    '--root-dir', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  const auditRow = JSON.parse(out.text());
  assert.equal(auditRow.exactHeadNow, true);
  assert.equal(auditRow.outcome, 'triggered');

  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare(
      `SELECT review_status, failed_at, failure_message, rereview_reason
       FROM reviewed_prs WHERE repo = ? AND pr_number = ?`
    ).get('laceyenterprises/agent-os', 238);
    assert.equal(row.review_status, 'pending');
    assert.equal(row.failed_at, null);
    assert.equal(row.failure_message, null);
    assert.equal(row.rereview_reason, 'retrigger-review: retry exact head after provider recovery');
  } finally {
    db.close();
  }
});

test('retrigger-review refuses active follow-up jobs when bumping is enabled', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });
  makeJob(rootDir, { status: 'pending' });

  const err = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
    '--audit-root-dir', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 1);
  assert.match(err.text(), /refused:job-active/);
});

test('retrigger-review preserves failed-review evidence unless allow-failed-reset is set', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'failed',
    failedAt: '2026-05-05T04:06:00.000Z',
    failureMessage: 'reviewer crashed',
  });

  const err = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 1);
  assert.match(err.text(), /watcher already retries failed review rows automatically/i);
  assert.match(err.text(), /--allow-failed-reset/);
});

test('retrigger-review allows failed reset when explicitly requested', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'failed',
    failedAt: '2026-05-05T04:06:00.000Z',
    failureMessage: 'reviewer crashed',
  });

  const out = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--allow-failed-reset',
    '--root-dir', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  assert.equal(JSON.parse(out.text()).outcome, 'triggered:no-job');
});

test('retrigger-review allows failed-orphan reset when explicitly requested', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'failed-orphan',
    failedAt: '2026-05-05T04:06:00.000Z',
    failureMessage: 'watcher restarted while reviewing',
  });

  const err = makeCaptureStream();
  const blocked = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'verified no orphan review posted',
    '--root-dir', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(blocked, 1);
  assert.match(err.text(), /failed-orphan/);

  const out = makeCaptureStream();
  const rc = await main([
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

test('retrigger-review explains reviewing recovery path', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'reviewing' });

  const err = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 1);
  assert.match(err.text(), /duplicate GitHub review/i);
  assert.match(err.text(), /--exact-head-now --cancel-active-review/);
});

test('retrigger-review exact-head-now still refuses active reviewers by default', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'reviewing',
    reviewerSessionUuid: 'sess-238',
    reviewerPgid: 8123,
    reviewerStartedAt: '2026-05-05T04:01:00.000Z',
    reviewerHeadSha: 'head-current-238',
  });

  const err = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--exact-head-now',
    '--root-dir', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 1);
  assert.match(err.text(), /refused:not-eligible: laceyenterprises\/agent-os#238 \(reviewing\)/);
});

test('retrigger-review exact-head-now can cancel and reset an active reviewer', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'reviewing',
    reviewerSessionUuid: 'sess-238',
    reviewerPgid: 8123,
    reviewerStartedAt: '2026-05-05T04:01:00.000Z',
    reviewerHeadSha: 'head-current-238',
  });

  const out = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--exact-head-now',
    '--cancel-active-review',
    '--no-bump-budget',
    '--root-dir', rootDir,
  ], {
    stdout: out,
    stderr: makeCaptureStream(),
    cancelActiveReviewImpl: async () => ({
      signalled: true,
      target: { kind: 'process-group', id: 8123 },
      error: null,
    }),
    waitForReviewerExitImpl: async () => ({ checked: true, exited: true, pgid: 8123 }),
  });

  assert.equal(rc, 0);
  const row = JSON.parse(out.text());
  assert.equal(row.outcome, 'already-pending');
  assert.equal(row.exactHeadNow, true);
  assert.equal(row.activeReviewReset, 'cancelled');
  const db = openReviewStateDb(rootDir);
  try {
    const refreshed = db.prepare(
      'SELECT review_status, reviewer_pgid, reviewer_session_uuid, rereview_reason FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/agent-os', 238);
    assert.equal(refreshed.review_status, 'pending');
    assert.equal(refreshed.reviewer_pgid, null);
    assert.equal(refreshed.reviewer_session_uuid, null);
    assert.equal(refreshed.rereview_reason, 'retrigger-review: retry');
  } finally {
    db.close();
  }
});

test('retrigger-review exact-head-now reports active-review cancellation refusal', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'reviewing',
    reviewerSessionUuid: 'sess-238',
    reviewerPgid: 8123,
  });

  const err = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--exact-head-now',
    '--cancel-active-review',
    '--root-dir', rootDir,
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
    cancelActiveReviewImpl: async () => ({
      signalled: false,
      target: { kind: 'process-group', id: 8123 },
      error: 'identity-unconfirmed',
    }),
  });

  assert.equal(rc, 1);
  assert.match(err.text(), /refused:active-review-cancel-failed/);
});

test('retrigger-review exact-head-now refuses when cancelled reviewer remains alive', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'reviewing',
    reviewerSessionUuid: 'sess-238',
    reviewerPgid: 8123,
  });

  const err = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--exact-head-now',
    '--cancel-active-review',
    '--root-dir', rootDir,
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
    cancelActiveReviewImpl: async () => ({
      signalled: true,
      target: { kind: 'process-group', id: 8123 },
      error: null,
    }),
    waitForReviewerExitImpl: async () => ({ checked: true, exited: false, pgid: 8123 }),
  });

  assert.equal(rc, 1);
  assert.match(err.text(), /refused:active-review-still-running/);
});

test('retrigger-review keeps wait failures inside the runtime exit-code contract', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'reviewing',
    reviewerSessionUuid: 'sess-238',
    reviewerPgid: 8123,
  });

  const err = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--exact-head-now',
    '--cancel-active-review',
    '--root-dir', rootDir,
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
    cancelActiveReviewImpl: async () => ({
      signalled: true,
      target: { kind: 'process-group', id: 8123 },
      error: null,
    }),
    waitForReviewerExitImpl: async () => { throw new Error('probe exploded'); },
  });

  assert.equal(rc, 4);
  assert.match(err.text(), /could not confirm active reviewer exit: probe exploded/);
  assert.doesNotMatch(err.text(), /\n\s+at\s/);
});

test('retrigger-review allow-active-review-reset refuses a live process group', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'reviewing',
    reviewerSessionUuid: 'sess-238',
    reviewerPgid: 8123,
  });

  const err = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--exact-head-now',
    '--allow-active-review-reset',
    '--root-dir', rootDir,
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
    isPgidAliveImpl: () => true,
  });

  assert.equal(rc, 1);
  assert.match(err.text(), /refused:active-review-still-running/);
});

test('retrigger-review allow-active-review-reset resets a dead process group', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'reviewing',
    reviewerSessionUuid: 'sess-238',
    reviewerPgid: 8123,
  });

  const out = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--exact-head-now',
    '--allow-active-review-reset',
    '--no-bump-budget',
    '--root-dir', rootDir,
  ], {
    stdout: out,
    stderr: makeCaptureStream(),
    isPgidAliveImpl: () => false,
  });

  assert.equal(rc, 0);
  assert.equal(JSON.parse(out.text()).activeReviewReset, 'allowed');
  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare(
      'SELECT review_status, reviewer_pgid, reviewer_session_uuid FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/agent-os', 238);
    assert.equal(row.review_status, 'pending');
    assert.equal(row.reviewer_pgid, null);
    assert.equal(row.reviewer_session_uuid, null);
  } finally {
    db.close();
  }
});

test('retrigger-review allow-active-review-reset preserves a null pgid guard', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'reviewing',
    reviewerSessionUuid: 'sess-238',
    reviewerPgid: null,
  });

  const out = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--exact-head-now',
    '--allow-active-review-reset',
    '--no-bump-budget',
    '--root-dir', rootDir,
  ], {
    stdout: out,
    stderr: makeCaptureStream(),
    isPgidAliveImpl: () => { throw new Error('null pgid must not be probed'); },
  });

  assert.equal(rc, 0);
  assert.equal(JSON.parse(out.text()).activeReviewReset, 'allowed');
  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare(
      'SELECT review_status, reviewer_pgid, reviewer_session_uuid FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/agent-os', 238);
    assert.equal(row.review_status, 'pending');
    assert.equal(row.reviewer_pgid, null);
    assert.equal(row.reviewer_session_uuid, null);
  } finally {
    db.close();
  }
});

test('retrigger-review cancel recovery tolerates watcher reconciliation to failed-orphan', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  let readCalls = 0;
  let resetCalls = 0;
  const out = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--exact-head-now',
    '--cancel-active-review',
    '--no-bump-budget',
    '--root-dir', rootDir,
  ], {
    stdout: out,
    stderr: makeCaptureStream(),
    readReviewRow: () => {
      readCalls += 1;
      return {
        repo: 'laceyenterprises/agent-os',
        pr_number: 238,
        pr_state: 'open',
        review_status: readCalls === 1 ? 'reviewing' : 'failed-orphan',
        revision_ref: 'head-current-238',
        reviewer_session_uuid: readCalls === 1 ? 'sess-238' : null,
        reviewer_pgid: readCalls === 1 ? 8123 : null,
      };
    },
    cancelActiveReviewImpl: async () => ({
      signalled: true,
      target: { kind: 'process-group', id: 8123 },
      error: null,
    }),
    waitForReviewerExitImpl: async () => ({ checked: true, exited: true, pgid: 8123 }),
    forceResetReview: (args) => {
      resetCalls += 1;
      if (resetCalls === 1) return { reset: false, reviewRow: null };
      assert.equal(args.expectedReviewStatus, 'failed-orphan');
      return {
        reset: true,
        reviewRow: {
          repo: 'laceyenterprises/agent-os',
          pr_number: 238,
          pr_state: 'open',
          review_status: 'pending',
          revision_ref: 'head-current-238',
        },
      };
    },
    rereview: () => ({ triggered: false, status: 'already-pending' }),
  });

  assert.equal(rc, 0);
  assert.equal(resetCalls, 2);
  assert.equal(JSON.parse(out.text()).activeReviewReset, 'cancelled');
});

test('retrigger-review cancel recovery resets a real failed-orphan row with a null pgid guard', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'reviewing',
    reviewerSessionUuid: 'sess-238',
    reviewerPgid: 8123,
  });
  let resetCalls = 0;

  const out = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--exact-head-now',
    '--cancel-active-review',
    '--no-bump-budget',
    '--root-dir', rootDir,
  ], {
    stdout: out,
    stderr: makeCaptureStream(),
    cancelActiveReviewImpl: async () => ({
      signalled: true,
      target: { kind: 'process-group', id: 8123 },
      error: null,
    }),
    waitForReviewerExitImpl: async () => ({ checked: true, exited: true, pgid: 8123 }),
    forceResetReview: (args) => {
      resetCalls += 1;
      if (resetCalls === 1) {
        const db = openReviewStateDb(rootDir);
        try {
          db.prepare(
            `UPDATE reviewed_prs
                SET review_status = 'failed-orphan',
                    reviewer_session_uuid = NULL,
                    reviewer_pgid = NULL
              WHERE repo = ? AND pr_number = ?`
          ).run('laceyenterprises/agent-os', 238);
        } finally {
          db.close();
        }
        return { reset: false, reviewRow: null };
      }
      assert.equal(args.expectedReviewStatus, 'failed-orphan');
      assert.equal(args.expectedReviewerSessionUuid, null);
      assert.equal(args.expectedReviewerPgid, null);
      return forceResetReviewToPending(args);
    },
  });

  assert.equal(rc, 0);
  assert.equal(resetCalls, 2);
  assert.equal(JSON.parse(out.text()).activeReviewReset, 'cancelled');
  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare(
      'SELECT review_status, reviewer_pgid, reviewer_session_uuid FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/agent-os', 238);
    assert.equal(row.review_status, 'pending');
    assert.equal(row.reviewer_pgid, null);
    assert.equal(row.reviewer_session_uuid, null);
  } finally {
    db.close();
  }
});

test('retrigger-review exact-head-now stops a stale active follow-up before re-arming review', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'posted',
    revisionRef: 'head-current-238',
  });
  makeJob(rootDir, {
    status: 'in_progress',
    revisionRef: 'head-stale-237',
    claimedAt: '2026-05-05T04:05:00.000Z',
    remediationWorker: { state: 'spawned' },
  });

  const out = makeCaptureStream();
  const stopped = [];
  let latestJobCalls = 0;
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--exact-head-now',
    '--no-bump-budget',
    '--root-dir', rootDir,
  ], {
    stdout: out,
    stderr: makeCaptureStream(),
    readReviewRow: () => ({
      repo: 'laceyenterprises/agent-os',
      pr_number: 238,
      pr_state: 'open',
      review_status: 'posted',
      revision_ref: 'head-current-238',
    }),
    latestJobFinder: () => {
      latestJobCalls += 1;
      if (latestJobCalls === 1) {
        return {
          jobPath: path.join(rootDir, 'data', 'follow-up-jobs', 'in-progress', 'job.json'),
          job: {
            jobId: 'job-238',
            status: 'in_progress',
            revisionRef: 'head-stale-237',
            remediationPlan: { maxRounds: 1 },
          },
        };
      }
      return null;
    },
    stopFollowUpJobImpl: async (args) => {
      stopped.push(args);
      return { job: { status: 'stopped' } };
    },
  });

  assert.equal(rc, 0);
  const row = JSON.parse(out.text());
  assert.equal(row.staleFollowUpStopped, true);
  assert.equal(stopped.length, 1);
  assert.match(stopped[0].reason, /Superseded by operator exact-head re-review request/);
});

test('retrigger-review refuses when a stale active follow-up survives the stop operation', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  const staleJob = {
    jobPath: path.join(rootDir, 'data', 'follow-up-jobs', 'in-progress', 'job.json'),
    job: {
      jobId: 'job-still-active-238',
      status: 'in_progress',
      revisionRef: 'head-stale-237',
      remediationPlan: { maxRounds: 2 },
    },
  };
  const audits = [];
  const err = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--exact-head-now',
    '--no-bump-budget',
    '--root-dir', rootDir,
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
    findAuditRow: () => null,
    appendAuditRow: (_auditRoot, row) => audits.push(row),
    readReviewRow: () => ({
      repo: 'laceyenterprises/agent-os',
      pr_number: 238,
      pr_state: 'open',
      review_status: 'posted',
      revision_ref: 'head-current-238',
    }),
    latestJobFinder: () => staleJob,
    stopFollowUpJobImpl: async () => ({ job: { status: 'stopped' } }),
    rereview: () => {
      throw new Error('must not re-arm while stale remediation is active');
    },
  });

  assert.equal(rc, 1);
  assert.match(err.text(), /refused:stale-follow-up-still-active/);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].outcome, 'refused:stale-follow-up-still-active');
  assert.equal(audits[0].staleFollowUpStopped, true);
});

test('retrigger-review returns runtime exit code when a refusal-path audit append fails', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'reviewing' });
  const err = makeCaptureStream();
  const rc = await main([
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

test('retrigger-review keeps reviewing rows blocked even with --allow-failed-reset', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'reviewing' });

  const err = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--allow-failed-reset',
    '--root-dir', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 1);
  assert.match(err.text(), /reviewing/);
});

test('retrigger-review skips the budget bump when no follow-up job exists', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });
  mkdirSync(getFollowUpJobDir(rootDir, 'pending'), { recursive: true });

  const out = makeCaptureStream();
  const rc = await main([
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

test('retrigger-review returns reason-input exit code for missing reason content', async () => {
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', '   ',
  ], { stdout: makeCaptureStream(), stderr: makeCaptureStream() });

  assert.equal(rc, 3);
});

test('retrigger-review reads reason from file', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });
  const reasonFile = path.join(rootDir, 'reason.txt');
  writeFileSync(reasonFile, 'from file\n', 'utf8');

  const out = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason-file', reasonFile,
    '--root-dir', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  assert.equal(JSON.parse(out.text()).reason, 'retrigger-review: from file');
});

test('retrigger-review reads --reason-stdin via injected reader', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });

  const out = makeCaptureStream();
  const rc = await main([
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
  assert.equal(JSON.parse(out.text()).reason, 'retrigger-review: from stdin');
});

test('retrigger-review --quiet suppresses informational output', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });

  const out = makeCaptureStream();
  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--quiet',
    '--root-dir', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  assert.equal(out.text(), '');
});

test('retrigger-review writes the audit ledger under data/operator-mutations by default', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });

  const rc = await main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
  ], { stdout: makeCaptureStream(), stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  assert.equal(existsSync(path.join(rootDir, 'data', 'operator-mutations')), true);
});

test('retrigger-review re-evaluates retries after a refused row with the same idempotency key', async () => {
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
  assert.equal(await main(args, { stdout: makeCaptureStream(), stderr: firstErr }), 1);
  assert.match(firstErr.text(), /reviewing/);

  const db = openReviewStateDb(rootDir);
  try {
    db.prepare('UPDATE reviewed_prs SET review_status = ? WHERE repo = ? AND pr_number = ?')
      .run('posted', 'laceyenterprises/agent-os', 238);
  } finally {
    db.close();
  }

  const out = makeCaptureStream();
  const secondRc = await main(args, { stdout: out, stderr: makeCaptureStream() });
  assert.equal(secondRc, 0);
  assert.equal(JSON.parse(out.text()).outcome, 'triggered:no-job');
});

test('retrigger-review returns runtime exit code with concise stderr when rereview throws', async () => {
  const err = makeCaptureStream();
  const rc = await main([
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

test('retrigger-review returns runtime exit code with concise stderr when terminal audit append fails after rereview succeeds', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });

  const err = makeCaptureStream();
  const rc = await main([
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

test('retrigger-review maps idempotency mismatches to usage and writes a refusal row', async () => {
  const rows = [];
  const err = makeCaptureStream();
  const rc = await main([
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

test('retrigger-review returns runtime exit code when readReviewRow throws', async () => {
  const err = makeCaptureStream();
  const rc = await main([
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

test('retrigger-review returns runtime exit code with broken root-dir', async () => {
  const err = makeCaptureStream();
  const rc = await main([
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

test('retrigger-review help documents structured usage and exit codes', async () => {
  const out = makeCaptureStream();
  const rc = await main(['--help'], {
    stdout: out,
    stderr: makeCaptureStream(),
  });

  assert.equal(rc, 0);
  assert.match(out.text(), /Required:/);
  assert.match(out.text(), /Optional:/);
  assert.match(out.text(), /Exit codes:/);
  assert.match(out.text(), /--allow-failed-reset/);
});

test('retrigger-review refuses unknown review statuses by default', async () => {
  const err = makeCaptureStream();
  const rc = await main([
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
