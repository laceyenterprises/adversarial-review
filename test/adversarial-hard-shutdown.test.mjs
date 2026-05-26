import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  hardShutdownInFlightWorkers,
  parseArgs,
} from '../src/adversarial-hard-shutdown.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';

function setupDb() {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  return db;
}

function seedReview(db, { repo, prNumber, status = 'reviewing' }) {
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
        review_attempts, last_attempted_at, reviewer_session_uuid,
        reviewer_pgid, reviewer_started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    repo,
    prNumber,
    '2026-05-26T10:00:00.000Z',
    'codex',
    'open',
    status,
    1,
    `2026-05-26T10:00:0${prNumber}.000Z`,
    `session-${prNumber}`,
    9000 + prNumber,
    `2026-05-26T10:00:0${prNumber}.000Z`,
  );
}

test('hard shutdown cancels active reviews and follow-up workers before returning', async () => {
  const db = setupDb();
  try {
    seedReview(db, { repo: 'lacey/repo', prNumber: 1 });
    seedReview(db, { repo: 'lacey/repo', prNumber: 2 });
    seedReview(db, { repo: 'lacey/repo', prNumber: 3, status: 'posted' });

    const events = [];
    const result = await hardShutdownInFlightWorkers({
      rootDir: '/tmp/adversarial-review-hard-shutdown-test',
      db,
      requestedAt: '2026-05-26T12:00:00.000Z',
      requestedBy: 'operator',
      reason: 'intentional teardown',
      signal: 'SIGTERM',
      waitMs: 25,
      cancelActiveReviewImpl: async ({ repo, prNumber, reason, signal }) => {
        events.push(`cancel-review:${repo}#${prNumber}:${signal}:${reason}`);
        return {
          signalled: true,
          target: { kind: 'process-group', id: 9000 + prNumber },
          receiptPath: `/tmp/review-${prNumber}.json`,
        };
      },
      waitForProcessGroupExitImpl: async (target) => {
        events.push(`wait-review:${target.id}`);
        return { checked: true, exited: true, target };
      },
      listFollowUpJobPathsImpl: () => [
        '/tmp/adversarial-review-hard-shutdown-test/data/follow-up-jobs/in-progress/job-a.json',
        '/tmp/adversarial-review-hard-shutdown-test/data/follow-up-jobs/in-progress/job-b.json',
      ],
      stopFollowUpJobImpl: async ({ jobPath, reason, signal, cancelWorker }) => {
        events.push(`stop-follow-up:${jobPath}:${signal}:${cancelWorker}:${reason}`);
        return {
          jobPath: jobPath.replace('/in-progress/', '/stopped/'),
          job: { jobId: jobPath.endsWith('job-a.json') ? 'job-a' : 'job-b' },
          cancellation: { signalled: true },
          workerExit: { checked: true, exited: true },
        };
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      events.map((event) => event.split(':')[0]),
      ['cancel-review', 'wait-review', 'cancel-review', 'wait-review', 'stop-follow-up', 'stop-follow-up']
    );
    assert.equal(result.reviews.length, 2);
    assert.equal(result.followUps.length, 2);
  } finally {
    db.close();
  }
});

test('hard shutdown reports failure when a live review cannot be signalled', async () => {
  const db = setupDb();
  try {
    seedReview(db, { repo: 'lacey/repo', prNumber: 4 });
    const result = await hardShutdownInFlightWorkers({
      db,
      cancelActiveReviewImpl: async () => ({
        signalled: false,
        target: { kind: 'process-group', id: 9004 },
        error: 'identity-unconfirmed',
      }),
      listFollowUpJobPathsImpl: () => [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.reviews[0].cancellation.error, 'identity-unconfirmed');
  } finally {
    db.close();
  }
});

test('hard shutdown CLI parses signal, wait, and operator reason', () => {
  assert.deepEqual(
    parseArgs(['--signal', 'SIGKILL', '--wait-ms=100', 'planned', 'maintenance']),
    {
      signal: 'SIGKILL',
      waitMs: 100,
      reason: 'planned maintenance',
    }
  );
});
