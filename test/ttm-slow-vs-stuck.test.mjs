/**
 * TTM-01: `slow` and `stuck` are different conditions and must not share one
 * finding.
 *
 * Every test here seeds a REAL merge distribution and lets the budget derive
 * itself from it. None of them pin a budget literal -- pinning one would be
 * the defect this change removes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { evaluateTtmFromDb } from '../src/ttm-tracker.mjs';

const REPO = 'laceyenterprises/agent-os';
const NOW = '2026-09-06T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);

// The budget these tests replace: 15m base + 10m/round. Referenced so the
// assertions can show the seeded PRs are over the OLD budget while inside the
// derived one -- which is exactly the population that used to page.
const LEGACY_BUDGET = (rounds) => 15 + rounds * 10;

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'ttm-slow-stuck-'));
}

function openDb() {
  const db = openReviewStateDb(tempRoot());
  ensureReviewStateSchema(db);
  return db;
}

function iso(minutesAgo) {
  return new Date(NOW_MS - minutesAgo * 60_000).toISOString();
}

function insertPr(db, {
  prNumber,
  reviewedAt,
  prState = 'open',
  mergedAt = null,
  closedAt = null,
  reviewStatus = 'posted',
  postedAt = null,
  rereviewRequestedAt = null,
  reviewerLeaseExpiresAt = null,
}) {
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, merged_at, closed_at,
        review_status, posted_at, rereview_requested_at, reviewer_lease_expires_at)
     VALUES (?, ?, ?, 'codex', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    REPO, prNumber, reviewedAt, prState, mergedAt, closedAt,
    reviewStatus, postedAt, rereviewRequestedAt, reviewerLeaseExpiresAt
  );
}

function insertPass(db, {
  prNumber,
  attemptNumber = 1,
  startedAt,
  endedAt = null,
  status = 'completed',
  verdict = 'comment-only',
}) {
  db.prepare(
    `INSERT INTO reviewer_passes
       (repo, pr_number, attempt_number, reviewer_class, reviewer_model,
        pass_kind, started_at, ended_at, status, verdict, metadata_json)
     VALUES (?, ?, ?, 'codex', 'gpt-5', ?, ?, ?, ?, ?, '{}')`
  ).run(
    REPO, prNumber, attemptNumber,
    attemptNumber > 1 ? 'rereview' : 'first-pass',
    startedAt, endedAt, status, verdict
  );
}

/**
 * Seed a merged-PR history whose time-to-merge really is
 * `baseMinutes + rounds * perRoundMinutes` (+/-25%), so the fit has something
 * measured to recover. Returns nothing: the point is that the tests never
 * name the budget, they name the DISTRIBUTION.
 */
function seedMergeDistribution(db, options) {
  // One transaction: this host's disk fsyncs every statement otherwise, which
  // turns a 60-PR fixture into minutes of wall clock.
  db.transaction(() => seedMergeDistributionRows(db, options))();
}

function seedMergeDistributionRows(db, {
  baseMinutes,
  perRoundMinutes,
  maxRounds = 4,
  perBucket = 12,
  firstPrNumber = 100,
}) {
  let prNumber = firstPrNumber;
  let mergeIndex = 0;
  for (let rounds = 0; rounds <= maxRounds; rounds += 1) {
    const centre = baseMinutes + rounds * perRoundMinutes;
    for (let i = 0; i < perBucket; i += 1) {
      const position = perBucket === 1 ? 0.5 : i / (perBucket - 1);
      const ttm = centre * (0.75 + 0.5 * position);
      // Merges are spread 25m apart going back from 6h ago, which sets the
      // Little's-Law reference queue depth the pressure term measures against.
      const mergedMinutesAgo = 360 + mergeIndex * 25;
      const reviewedAt = iso(mergedMinutesAgo + ttm);
      insertPr(db, {
        prNumber,
        reviewedAt,
        prState: 'merged',
        mergedAt: iso(mergedMinutesAgo),
        postedAt: iso(mergedMinutesAgo + 1),
      });
      for (let attempt = 1; attempt <= rounds + 1; attempt += 1) {
        insertPass(db, {
          prNumber,
          attemptNumber: attempt,
          startedAt: reviewedAt,
          endedAt: iso(mergedMinutesAgo + 1),
        });
      }
      prNumber += 1;
      mergeIndex += 1;
    }
  }
}

function evaluate(db, configOverrides = {}) {
  return evaluateTtmFromDb(db, {
    now: () => new Date(NOW),
    env: {},
    config: configOverrides,
  });
}

const flagKinds = (result, prNumber) => result.flags
  .filter((flag) => flag.prNumber === prNumber)
  .map((flag) => flag.flagKind)
  .sort();

const stuckFlags = (result, prNumber) => result.flags
  .filter((flag) => flag.prNumber === prNumber && flag.progressClass === 'stuck');

// ── 1. Moving normally under load must not raise a page-tier condition ─────

test('a PR moving normally under load is neither slow nor stuck', () => {
  const db = openDb();
  try {
    // Measured reality: ~150m base, ~50m/round. Under the old 15m + 10m/round
    // budget every single one of these merges breached.
    seedMergeDistribution(db, { baseMinutes: 150, perRoundMinutes: 50 });

    // Genuine load: 20 other PRs in flight, roughly double the Little's-Law
    // reference depth this distribution was measured at.
    db.transaction(() => {
      for (let prNumber = 9200; prNumber < 9220; prNumber += 1) {
        insertPr(db, { prNumber, reviewedAt: iso(5), reviewStatus: 'pending' });
      }
    })();

    // A healthy in-flight PR: two completed passes, the latest 20m ago, open
    // 220m. Well past LEGACY_BUDGET(1) = 25m, well inside the measured curve.
    insertPr(db, { prNumber: 9001, reviewedAt: iso(220), reviewStatus: 'pending' });
    insertPass(db, { prNumber: 9001, attemptNumber: 1, startedAt: iso(210), endedAt: iso(180) });
    insertPass(db, { prNumber: 9001, attemptNumber: 2, startedAt: iso(40), endedAt: iso(20), verdict: 'request-changes' });

    const result = evaluate(db);
    const pr = result.timelines.find((row) => row.prNumber === 9001);

    assert.equal(result.budget.blind, false);
    assert.equal(result.budget.source, 'measured-fit');
    assert.ok(
      result.budget.pressure.multiplier > 1,
      'the fixture must actually be under load, or this proves nothing'
    );
    assert.ok(
      pr.elapsedMinutes > LEGACY_BUDGET(pr.reviewRounds),
      'this PR must be one the OLD budget would have flagged'
    );
    assert.deepEqual(
      flagKinds(result, 9001),
      [],
      'a PR moving at the measured pace raises nothing at all'
    );
    assert.equal(result.rollup.stuckOpenPrs, 0, 'nothing in this fixture is stuck');
  } finally {
    db.close();
  }
});

test('the derived budget really is derived: a faster fleet produces a tighter budget', () => {
  // Same open PR, two different measured histories. If the budget were a
  // literal both runs would agree; they must not.
  function budgetFor(baseMinutes, perRoundMinutes) {
    const db = openDb();
    try {
      seedMergeDistribution(db, { baseMinutes, perRoundMinutes });
      insertPr(db, { prNumber: 9002, reviewedAt: iso(150), reviewStatus: 'pending' });
      insertPass(db, {
        prNumber: 9002,
        attemptNumber: 1,
        startedAt: iso(148),
        endedAt: iso(10),
        verdict: 'request-changes',
      });
      const result = evaluate(db);
      return {
        base: result.config.baseBudgetMinutes,
        perRound: result.config.perRoundBudgetMinutes,
        flags: flagKinds(result, 9002),
      };
    } finally {
      db.close();
    }
  }

  const slowFleet = budgetFor(150, 50);
  const fastFleet = budgetFor(20, 6);

  assert.ok(
    slowFleet.base > fastFleet.base * 2,
    `slow-fleet base ${slowFleet.base} must dwarf fast-fleet base ${fastFleet.base}`
  );
  // Same 150m-old PR: inside the slow fleet's budget, over the fast fleet's.
  // A literal budget could not produce both answers.
  assert.deepEqual(slowFleet.flags, []);
  assert.deepEqual(fastFleet.flags, ['round_budget_breach']);
});

// ── 2. No review pass since the re-review request => STUCK ────────────────

test('an unanswered re-review request is stuck regardless of elapsed time or budget', () => {
  const db = openDb();
  try {
    // A very generous measured budget, so nothing here can be called slow.
    seedMergeDistribution(db, { baseMinutes: 400, perRoundMinutes: 100 });

    insertPr(db, {
      prNumber: 9003,
      reviewedAt: iso(120),
      reviewStatus: 'pending',
      postedAt: iso(115),
      rereviewRequestedAt: iso(95),
    });
    // The only pass STARTED BEFORE the re-review was requested: nothing has
    // picked the PR up since. Its verdict asked for changes, so this PR is not
    // terminal-clean and the only thing that can flag it is the stall.
    insertPass(db, {
      prNumber: 9003,
      attemptNumber: 1,
      startedAt: iso(118),
      endedAt: iso(115),
      verdict: 'request-changes',
    });

    const result = evaluate(db);
    const pr = result.timelines.find((row) => row.prNumber === 9003);

    assert.equal(pr.rereviewAnswered, false);
    assert.ok(
      pr.elapsedMinutes < result.config.baseBudgetMinutes,
      'the PR must be INSIDE the TTM budget, so only the stall can be flagging it'
    );
    assert.deepEqual(flagKinds(result, 9003), ['rereview_unanswered']);
    assert.equal(stuckFlags(result, 9003).length, 1);
    assert.equal(result.rollup.stuckOpenPrs, 1);
  } finally {
    db.close();
  }
});

test('a re-review that WAS answered is not stuck, even mid-pass', () => {
  const db = openDb();
  try {
    seedMergeDistribution(db, { baseMinutes: 400, perRoundMinutes: 100 });
    insertPr(db, {
      prNumber: 9004,
      reviewedAt: iso(120),
      reviewStatus: 'reviewing',
      postedAt: iso(115),
      rereviewRequestedAt: iso(95),
    });
    insertPass(db, {
      prNumber: 9004,
      attemptNumber: 1,
      startedAt: iso(118),
      endedAt: iso(115),
      verdict: 'request-changes',
    });
    // A reviewer picked it up after the request and is still running. Running
    // IS progress; a pass in flight must never read as a stall.
    insertPass(db, {
      prNumber: 9004,
      attemptNumber: 2,
      startedAt: iso(90),
      endedAt: null,
      status: 'running',
      verdict: null,
    });

    const result = evaluate(db);
    assert.equal(result.timelines.find((row) => row.prNumber === 9004).rereviewAnswered, true);
    assert.deepEqual(flagKinds(result, 9004), []);
  } finally {
    db.close();
  }
});

// ── 3. Terminal clean but unmergeable => STUCK ────────────────────────────

test('a terminal-clean verdict that cannot merge is stuck regardless of elapsed time or budget', () => {
  const db = openDb();
  try {
    seedMergeDistribution(db, { baseMinutes: 400, perRoundMinutes: 100 });

    insertPr(db, { prNumber: 9005, reviewedAt: iso(60), postedAt: iso(45) });
    insertPass(db, {
      prNumber: 9005,
      attemptNumber: 1,
      startedAt: iso(58),
      endedAt: iso(45),
      verdict: 'approved',
    });

    const result = evaluate(db);
    const pr = result.timelines.find((row) => row.prNumber === 9005);

    assert.equal(pr.terminalClean, true);
    assert.ok(
      pr.elapsedMinutes < result.config.baseBudgetMinutes,
      'the PR must be INSIDE the TTM budget, so only the terminal stall can be flagging it'
    );
    assert.deepEqual(flagKinds(result, 9005), ['terminal_but_unmerged']);
    assert.equal(stuckFlags(result, 9005).length, 1);
  } finally {
    db.close();
  }
});

test('rollup separates terminal-clean rows blocked by an unanswered rereview queue', () => {
  const db = openDb();
  try {
    seedMergeDistribution(db, { baseMinutes: 400, perRoundMinutes: 100 });
    insertPr(db, {
      prNumber: 9015,
      reviewedAt: iso(120),
      reviewStatus: 'pending',
      postedAt: iso(60),
      rereviewRequestedAt: iso(45),
    });
    insertPass(db, {
      prNumber: 9015,
      attemptNumber: 2,
      passKind: 'rereview',
      startedAt: iso(75),
      endedAt: iso(60),
      verdict: 'approved',
    });

    const result = evaluate(db);
    assert.deepEqual(flagKinds(result, 9015), ['rereview_unanswered', 'terminal_but_unmerged']);
    assert.equal(result.rollup.terminalButUnmergedOpenCount, 1);
    assert.equal(result.rollup.terminalCleanRereviewBlockedOpenCount, 1);
  } finally {
    db.close();
  }
});

// ── 4. Lease/gate deadlock => STUCK ──────────────────────────────────────

test('a reviewer lease that expired while the row still claims a review is stuck', () => {
  const db = openDb();
  try {
    seedMergeDistribution(db, { baseMinutes: 400, perRoundMinutes: 100 });
    insertPr(db, {
      prNumber: 9006,
      reviewedAt: iso(90),
      reviewStatus: 'reviewing',
      reviewerLeaseExpiresAt: iso(50),
    });
    insertPass(db, {
      prNumber: 9006,
      attemptNumber: 1,
      startedAt: iso(88),
      endedAt: null,
      status: 'running',
      verdict: null,
    });

    const result = evaluate(db);
    assert.deepEqual(flagKinds(result, 9006), ['reviewer_lease_expired']);
    assert.equal(stuckFlags(result, 9006).length, 1);

    // A live lease on the same shape of row is not a deadlock.
    db.prepare('UPDATE reviewed_prs SET reviewer_lease_expires_at = ? WHERE pr_number = ?')
      .run(new Date(NOW_MS + 30 * 60_000).toISOString(), 9006);
    assert.deepEqual(flagKinds(evaluate(db), 9006), []);
  } finally {
    db.close();
  }
});

// ── 5. Load awareness ────────────────────────────────────────────────────

test('queue pressure widens the budget, and saturation is reported rather than absorbed', () => {
  const db = openDb();
  try {
    seedMergeDistribution(db, { baseMinutes: 150, perRoundMinutes: 50 });
    const quiet = evaluate(db);
    const quietBase = quiet.config.baseBudgetMinutes;
    assert.equal(quiet.config.budgetProvenance.queuePressureMultiplier, 1);

    // Flood the queue well past the Little's-Law reference depth.
    db.transaction(() => {
      for (let prNumber = 9100; prNumber < 9140; prNumber += 1) {
        insertPr(db, { prNumber, reviewedAt: iso(30), reviewStatus: 'pending' });
      }
    })();
    const loaded = evaluate(db);
    assert.ok(
      loaded.config.baseBudgetMinutes > quietBase,
      'a deeper queue must widen the budget'
    );
    assert.equal(loaded.config.budgetProvenance.queuePressureSaturated, true);
    assert.equal(loaded.rollup.queuePressureSaturated, true);
  } finally {
    db.close();
  }
});

// ── 6. Blind, never false-clean ──────────────────────────────────────────

test('an unreadable distribution reports blind, withholds SLOW, and still sees STUCK', () => {
  const db = openDb();
  try {
    seedMergeDistribution(db, { baseMinutes: 20, perRoundMinutes: 5 });
    // Over any plausible budget AND terminal-clean-unmerged: it would be both
    // slow and stuck if the distribution were readable.
    insertPr(db, { prNumber: 9007, reviewedAt: iso(600), postedAt: iso(500) });
    insertPass(db, {
      prNumber: 9007,
      attemptNumber: 1,
      startedAt: iso(590),
      endedAt: iso(500),
      verdict: 'approved',
    });

    const sighted = evaluate(db);
    assert.equal(sighted.budget.blind, false);
    assert.deepEqual(flagKinds(sighted, 9007), ['round_budget_breach', 'terminal_but_unmerged']);

    // Now blind the distribution read only. The timelines still load; the
    // merged-PR sample query is what fails.
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (String(sql).includes('ORDER BY r.merged_at DESC')) {
        throw Object.assign(new Error('no such table: reviewed_prs'), { code: 'SQLITE_ERROR' });
      }
      return realPrepare(sql);
    };
    const blind = evaluate(db);
    db.prepare = realPrepare;

    assert.equal(blind.budget.blind, true);
    assert.match(blind.budget.blindReason, /unreadable/);
    assert.equal(blind.rollup.budgetBlind, true);
    // SLOW is withheld: there is no budget to be over.
    assert.equal(blind.rollup.openPrsBreachingBudget, null, 'blind must be a gap, not a zero');
    assert.equal(blind.rollup.baseBudgetMinutes, null);
    // STUCK still sees, because it never consulted the budget. Blindness about
    // slowness is not a clean bill of health.
    assert.deepEqual(flagKinds(blind, 9007), ['terminal_but_unmerged']);
    assert.equal(blind.rollup.stuckOpenPrs, 1);
  } finally {
    db.close();
  }
});
