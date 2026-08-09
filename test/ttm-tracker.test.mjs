import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import {
  evaluateTtmFromDb,
  runTtmTrackerTick,
} from '../src/ttm-tracker.mjs';

const REPO = 'laceyenterprises/agent-os';
const NOW = '2026-08-09T18:00:00.000Z';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'ttm-tracker-'));
}

function openDb(rootDir) {
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  return db;
}

function insertReviewRow(db, overrides = {}) {
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, merged_at, closed_at,
        review_status, posted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    overrides.repo || REPO,
    overrides.prNumber,
    overrides.reviewedAt,
    overrides.reviewer || 'codex',
    overrides.prState || 'open',
    overrides.mergedAt ?? null,
    overrides.closedAt ?? null,
    overrides.reviewStatus || 'posted',
    overrides.postedAt ?? null
  );
}

function insertPass(db, overrides = {}) {
  db.prepare(
    `INSERT INTO reviewer_passes
       (repo, pr_number, attempt_number, reviewer_class, reviewer_model,
        pass_kind, started_at, ended_at, status, verdict, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    overrides.repo || REPO,
    overrides.prNumber,
    overrides.attemptNumber ?? 1,
    overrides.reviewerClass || 'codex',
    overrides.reviewerModel || 'gpt-5',
    overrides.passKind || (overrides.attemptNumber > 1 ? 'rereview' : 'first-pass'),
    overrides.startedAt,
    overrides.endedAt,
    overrides.status || 'completed',
    overrides.verdict ?? 'comment-only',
    JSON.stringify(overrides.metadata || {})
  );
}

test('rounds-aware budget flags a 0-round overdue PR but not a 3-round PR within expanded budget', () => {
  const rootDir = tempRoot();
  const db = openDb(rootDir);
  try {
    insertReviewRow(db, {
      prNumber: 806,
      reviewedAt: '2026-08-09T17:40:00.000Z',
      postedAt: '2026-08-09T17:50:00.000Z',
    });
    insertPass(db, {
      prNumber: 806,
      attemptNumber: 1,
      startedAt: '2026-08-09T17:45:00.000Z',
      endedAt: '2026-08-09T17:50:00.000Z',
    });

    insertReviewRow(db, {
      prNumber: 5102,
      reviewedAt: '2026-08-09T17:10:00.000Z',
      postedAt: '2026-08-09T17:55:00.000Z',
    });
    for (const attemptNumber of [1, 2, 3, 4]) {
      insertPass(db, {
        prNumber: 5102,
        attemptNumber,
        startedAt: `2026-08-09T17:${10 + attemptNumber * 8}:00.000Z`,
        endedAt: `2026-08-09T17:${14 + attemptNumber * 8}:00.000Z`,
      });
    }

    const result = evaluateTtmFromDb(db, {
      now: () => new Date(NOW),
      config: { baseBudgetMinutes: 15, perRoundBudgetMinutes: 20, terminalUnmergedMinutes: 120 },
    });
    const budgetFlags = result.flags.filter((flag) => flag.flagKind === 'round_budget_breach');
    assert.deepEqual(budgetFlags.map((flag) => flag.prNumber), [806]);
    assert.equal(result.timelines.find((row) => row.prNumber === 5102).reviewRounds, 3);
  } finally {
    db.close();
  }
});

test('terminal-but-unmerged flags settled clean PRs distinctly from under-review PRs', () => {
  const rootDir = tempRoot();
  const db = openDb(rootDir);
  try {
    insertReviewRow(db, {
      prNumber: 1,
      reviewedAt: '2026-08-09T17:30:00.000Z',
      postedAt: '2026-08-09T17:35:00.000Z',
    });
    insertPass(db, {
      prNumber: 1,
      startedAt: '2026-08-09T17:31:00.000Z',
      endedAt: '2026-08-09T17:35:00.000Z',
      verdict: 'comment-only',
    });

    insertReviewRow(db, {
      prNumber: 2,
      reviewedAt: '2026-08-09T17:30:00.000Z',
      reviewStatus: 'reviewing',
      postedAt: null,
    });
    insertPass(db, {
      prNumber: 2,
      startedAt: '2026-08-09T17:31:00.000Z',
      endedAt: null,
      status: 'running',
      verdict: null,
    });

    const result = evaluateTtmFromDb(db, {
      now: () => new Date(NOW),
      config: { baseBudgetMinutes: 120, perRoundBudgetMinutes: 10, terminalUnmergedMinutes: 10 },
    });
    const terminalFlags = result.flags.filter((flag) => flag.flagKind === 'terminal_but_unmerged');
    assert.deepEqual(terminalFlags.map((flag) => flag.prNumber), [1]);
    assert.ok(!result.flags.some((flag) => flag.prNumber === 2 && flag.flagKind === 'terminal_but_unmerged'));
  } finally {
    db.close();
  }
});

test('rollup computes median, p90, open breaches, and 12h terminal stall duration', () => {
  const rootDir = tempRoot();
  const db = openDb(rootDir);
  try {
    insertReviewRow(db, {
      prNumber: 10,
      reviewedAt: '2026-08-09T15:00:00.000Z',
      prState: 'merged',
      mergedAt: '2026-08-09T15:10:00.000Z',
      postedAt: '2026-08-09T15:05:00.000Z',
    });
    insertReviewRow(db, {
      prNumber: 11,
      reviewedAt: '2026-08-09T15:00:00.000Z',
      prState: 'merged',
      mergedAt: '2026-08-09T15:30:00.000Z',
      postedAt: '2026-08-09T15:25:00.000Z',
    });
    insertReviewRow(db, {
      prNumber: 12,
      reviewedAt: '2026-08-09T15:00:00.000Z',
      prState: 'merged',
      mergedAt: '2026-08-09T16:00:00.000Z',
      postedAt: '2026-08-09T15:55:00.000Z',
    });
    insertReviewRow(db, {
      prNumber: 13,
      reviewedAt: '2026-08-09T17:30:00.000Z',
      postedAt: '2026-08-09T17:40:00.000Z',
    });
    insertPass(db, {
      prNumber: 13,
      startedAt: '2026-08-09T17:35:00.000Z',
      endedAt: '2026-08-09T17:40:00.000Z',
    });

    const tick = runTtmTrackerTick(db, {
      now: () => new Date(NOW),
      config: { baseBudgetMinutes: 15, perRoundBudgetMinutes: 10, terminalUnmergedMinutes: 10 },
    });

    assert.equal(tick.rollup.medianTimeToMergeMinutes, 30);
    assert.equal(tick.rollup.p90TimeToMergeMinutes, 54);
    assert.equal(tick.rollup.openPrsBreachingBudget, 1);
    assert.equal(tick.rollup.terminalButUnmergedStallsLast12h, 1);
    assert.equal(tick.rollup.terminalButUnmergedMaxDurationMinutesLast12h, 20);
  } finally {
    db.close();
  }
});

test('rollup includes current terminal stall duration when activation event aged out of the window', () => {
  const rootDir = tempRoot();
  const db = openDb(rootDir);
  try {
    insertReviewRow(db, {
      prNumber: 14,
      reviewedAt: '2026-08-09T17:25:00.000Z',
      postedAt: '2026-08-09T17:30:00.000Z',
    });
    insertPass(db, {
      prNumber: 14,
      startedAt: '2026-08-09T17:26:00.000Z',
      endedAt: '2026-08-09T17:30:00.000Z',
    });

    runTtmTrackerTick(db, {
      now: () => new Date('2026-08-09T17:42:00.000Z'),
      config: {
        baseBudgetMinutes: 15,
        perRoundBudgetMinutes: 10,
        terminalUnmergedMinutes: 10,
        rollupWindowHours: 0.25,
      },
    });
    const tick = runTtmTrackerTick(db, {
      now: () => new Date(NOW),
      config: {
        baseBudgetMinutes: 15,
        perRoundBudgetMinutes: 10,
        terminalUnmergedMinutes: 10,
        rollupWindowHours: 0.25,
      },
    });

    assert.equal(tick.rollup.terminalButUnmergedStallsLast12h, 1);
    assert.equal(tick.rollup.terminalButUnmergedMaxDurationMinutesLast12h, 30);
    assert.equal(tick.rollup.terminalButUnmergedTotalDurationMinutesLast12h, 30);
  } finally {
    db.close();
  }
});

test('rollup uses resolved terminal stall duration instead of the activation threshold duration', () => {
  const rootDir = tempRoot();
  const db = openDb(rootDir);
  try {
    insertReviewRow(db, {
      prNumber: 15,
      reviewedAt: '2026-08-09T17:25:00.000Z',
      postedAt: '2026-08-09T17:30:00.000Z',
    });
    insertPass(db, {
      prNumber: 15,
      startedAt: '2026-08-09T17:26:00.000Z',
      endedAt: '2026-08-09T17:30:00.000Z',
    });

    runTtmTrackerTick(db, {
      now: () => new Date('2026-08-09T17:42:00.000Z'),
      config: { baseBudgetMinutes: 15, perRoundBudgetMinutes: 10, terminalUnmergedMinutes: 10 },
    });
    runTtmTrackerTick(db, {
      now: () => new Date(NOW),
      config: { baseBudgetMinutes: 15, perRoundBudgetMinutes: 10, terminalUnmergedMinutes: 10 },
    });
    db.prepare("UPDATE reviewed_prs SET pr_state = 'merged', merged_at = ? WHERE pr_number = ?")
      .run('2026-08-09T18:05:00.000Z', 15);
    const tick = runTtmTrackerTick(db, {
      now: () => new Date('2026-08-09T18:06:00.000Z'),
      config: { baseBudgetMinutes: 15, perRoundBudgetMinutes: 10, terminalUnmergedMinutes: 10 },
    });

    assert.equal(tick.rollup.terminalButUnmergedOpenCount, 0);
    assert.equal(tick.rollup.terminalButUnmergedStallsLast12h, 1);
    assert.equal(tick.rollup.terminalButUnmergedMaxDurationMinutesLast12h, 30);
    assert.equal(tick.rollup.terminalButUnmergedTotalDurationMinutesLast12h, 30);
  } finally {
    db.close();
  }
});

test('situational event gating does not refire unchanged active flags and records resolution', () => {
  const rootDir = tempRoot();
  const db = openDb(rootDir);
  try {
    insertReviewRow(db, {
      prNumber: 20,
      reviewedAt: '2026-08-09T17:30:00.000Z',
      postedAt: '2026-08-09T17:35:00.000Z',
    });
    insertPass(db, {
      prNumber: 20,
      startedAt: '2026-08-09T17:31:00.000Z',
      endedAt: '2026-08-09T17:35:00.000Z',
    });

    const first = runTtmTrackerTick(db, {
      now: () => new Date(NOW),
      config: { baseBudgetMinutes: 15, perRoundBudgetMinutes: 10, terminalUnmergedMinutes: 10 },
    });
    const second = runTtmTrackerTick(db, {
      now: () => new Date('2026-08-09T18:01:00.000Z'),
      config: { baseBudgetMinutes: 15, perRoundBudgetMinutes: 10, terminalUnmergedMinutes: 10 },
    });
    assert.equal(first.sync.activated, 2);
    assert.equal(second.sync.activated, 0);
    assert.equal(second.sync.refreshed, 2);

    db.prepare("UPDATE reviewed_prs SET pr_state = 'merged', merged_at = ? WHERE pr_number = ?")
      .run('2026-08-09T18:02:00.000Z', 20);
    const resolved = runTtmTrackerTick(db, {
      now: () => new Date('2026-08-09T18:03:00.000Z'),
      config: { baseBudgetMinutes: 15, perRoundBudgetMinutes: 10, terminalUnmergedMinutes: 10 },
    });
    assert.equal(resolved.sync.resolved, 2);
    const events = db.prepare('SELECT state, COUNT(*) AS count FROM ttm_flag_events GROUP BY state').all();
    assert.deepEqual(events, [
      { state: 'active', count: 2 },
      { state: 'resolved', count: 2 },
    ]);
  } finally {
    db.close();
  }
});

test('flag event writes are transactionally stash-and-fail proof', () => {
  const rootDir = tempRoot();
  const db = openDb(rootDir);
  try {
    insertReviewRow(db, {
      prNumber: 30,
      reviewedAt: '2026-08-09T17:30:00.000Z',
      postedAt: '2026-08-09T17:35:00.000Z',
    });
    insertPass(db, {
      prNumber: 30,
      startedAt: '2026-08-09T17:31:00.000Z',
      endedAt: '2026-08-09T17:35:00.000Z',
    });
    db.prepare(
      `CREATE TRIGGER ttm_flag_events_fail
         BEFORE INSERT ON ttm_flag_events
       BEGIN
         SELECT RAISE(ABORT, 'injected ttm flag event failure');
       END`
    ).run();
    assert.throws(() => runTtmTrackerTick(db, {
      now: () => new Date(NOW),
      config: { baseBudgetMinutes: 15, perRoundBudgetMinutes: 10, terminalUnmergedMinutes: 10 },
    }), /injected ttm flag event failure/);
    const eventCount = db.prepare('SELECT COUNT(*) AS count FROM ttm_flag_events').get().count;
    const stateCount = db.prepare('SELECT COUNT(*) AS count FROM ttm_flag_state').get().count;
    assert.equal(eventCount, 0);
    assert.equal(stateCount, 0);
  } finally {
    db.close();
  }
});
