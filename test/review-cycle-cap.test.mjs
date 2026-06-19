import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import {
  PAUSED_FOR_REDESIGN_LABEL,
  REVIEWER_CYCLE_CAP_REACHED_LABEL,
  buildReviewCycleCapEscalationComment,
  markReviewCycleEscalated,
  recentReviewCycleVerdicts,
  recordReviewCycleVerdict,
  shouldEscalateReviewCycle,
} from '../src/review-cycle-cap.mjs';
import { clearReviewCycleCapForOverride } from '../src/watcher.mjs';

const REPO = 'laceyenterprises/adversarial-review';
const PR = 123;

function setupDb() {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  return db;
}

function record(db, n, at = `2026-06-04T0${n}:00:00.000Z`) {
  return recordReviewCycleVerdict(db, {
    repo: REPO,
    prNumber: PR,
    headSha: `sha-${n}`,
    verdictAt: at,
    verdictSummary: `## Summary\nVerdict ${n} still found blockers.`,
    windowHours: 24,
  });
}

test('5 successive verdicts each followed by a new commit make the 6th attempt escalate', () => {
  const db = setupDb();
  try {
    for (let i = 1; i <= 5; i += 1) {
      assert.equal(record(db, i).count, i);
    }

    const decision = shouldEscalateReviewCycle(db, {
      repo: REPO,
      prNumber: PR,
      headSha: 'sha-6',
      cap: 5,
      windowHours: 24,
      now: '2026-06-04T06:00:00.000Z',
    });

    assert.equal(decision.count, 6);
    assert.equal(decision.escalate, true);
    const recent = recentReviewCycleVerdicts(db, { repo: REPO, prNumber: PR, limit: 5 });
    const comment = buildReviewCycleCapEscalationComment({ cap: 5, recentVerdicts: recent });
    assert.match(comment, /Review cycle cap reached/);
    assert.match(comment, /operator-approved/);
    assert.match(comment, /merge-agent-requested/);
    assert.match(comment, /paused-for-redesign/);
  } finally {
    db.close();
  }
});

test('4 successive verdicts do not escalate', () => {
  const db = setupDb();
  try {
    for (let i = 1; i <= 4; i += 1) record(db, i);
    const decision = shouldEscalateReviewCycle(db, {
      repo: REPO,
      prNumber: PR,
      headSha: 'sha-5',
      cap: 5,
      windowHours: 24,
      now: '2026-06-04T05:00:00.000Z',
    });
    assert.equal(decision.count, 5);
    assert.equal(decision.escalate, false);
  } finally {
    db.close();
  }
});

test('same-head re-review does not increment the counter', () => {
  const db = setupDb();
  try {
    assert.equal(record(db, 1).count, 1);
    const sameHead = recordReviewCycleVerdict(db, {
      repo: REPO,
      prNumber: PR,
      headSha: 'sha-1',
      verdictAt: '2026-06-04T02:00:00.000Z',
      verdictSummary: 'Same head review.',
      windowHours: 24,
    });
    assert.equal(sameHead.count, 1);

    const decision = shouldEscalateReviewCycle(db, {
      repo: REPO,
      prNumber: PR,
      headSha: 'sha-2',
      cap: 5,
      windowHours: 24,
      now: '2026-06-04T03:00:00.000Z',
    });
    assert.equal(decision.count, 2);
    assert.equal(decision.escalate, false);
  } finally {
    db.close();
  }
});

test('verdicts outside the review cycle window reset the counter', () => {
  const db = setupDb();
  try {
    recordReviewCycleVerdict(db, {
      repo: REPO,
      prNumber: PR,
      headSha: 'old-sha',
      verdictAt: '2026-06-04T00:00:00.000Z',
      verdictSummary: 'Old verdict.',
      windowHours: 24,
    });
    const decision = shouldEscalateReviewCycle(db, {
      repo: REPO,
      prNumber: PR,
      headSha: 'new-sha',
      cap: 5,
      windowHours: 24,
      now: '2026-06-05T01:00:01.000Z',
    });
    assert.equal(decision.count, 1);
    assert.equal(decision.escalate, false);
  } finally {
    db.close();
  }
});

for (const overrideLabel of ['operator-approved', 'merge-agent-requested', PAUSED_FOR_REDESIGN_LABEL]) {
  test(`${overrideLabel} clears cycle-cap label and resets the counter`, async () => {
    const db = setupDb();
    const removed = [];
    const octokit = {
      rest: {
        issues: {
          removeLabel: async (params) => {
            removed.push(params);
          },
        },
      },
    };

    try {
      record(db, 1);
      markReviewCycleEscalated(db, {
        repo: REPO,
        prNumber: PR,
        headSha: 'sha-1',
        escalatedAt: '2026-06-04T02:00:00.000Z',
      });

      const result = await clearReviewCycleCapForOverride({
        db,
        octokit,
        repoPath: REPO,
        prNumber: PR,
        headSha: 'sha-1',
        labelNames: [REVIEWER_CYCLE_CAP_REACHED_LABEL, overrideLabel],
        logger: { log() {}, warn() {} },
      });

      assert.equal(result.cleared, true);
      assert.equal(result.overrideLabel, overrideLabel);
      assert.equal(removed.length, 1);
      assert.equal(removed[0].name, REVIEWER_CYCLE_CAP_REACHED_LABEL);
      const decision = shouldEscalateReviewCycle(db, {
        repo: REPO,
        prNumber: PR,
        headSha: 'sha-2',
        cap: 5,
        windowHours: 24,
        now: '2026-06-04T03:00:00.000Z',
      });
      assert.equal(decision.count, 1);
      assert.equal(decision.escalate, false);
    } finally {
      db.close();
    }
  });
}

