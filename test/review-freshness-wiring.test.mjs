// Wiring for the review-freshness liveness pager (watcher.mjs tick-end): the DB
// reads that feed maybeFireReviewStalledAlert. RCA: reviewer dispatch can
// succeed while no review lands, so the watcher must page off genuine GitHub
// artifact evidence and a genuinely-open/not-yet-posted count — never a
// maskable per-PR status or resettable row-cycle timestamp.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import {
  parsePostedAtMs,
  oldestOpenPrAwaitingFirstPassReviewAtMs,
  latestPostedReviewAtMs,
  countOpenPrsAwaitingFirstPassReview,
  stmtLatestGenuinePostedReviewAt,
} from '../src/review-state-db.mjs';
import {
  maybeFireReviewStalledAlert,
  REVIEW_STALL_THRESHOLD_MS,
} from '../src/review-freshness-detector.mjs';

function withTempDb(fn) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'review-freshness-wiring-'));
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    return fn(db);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

async function withTempDbAsync(fn) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'review-freshness-wiring-'));
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    return await fn(db);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

let prSeq = 1;
function seed(db, { prState, reviewStatus, postedAt = null }) {
  const prNumber = prSeq++;
  db.prepare(
    `INSERT INTO reviewed_prs (
       repo, pr_number, reviewed_at, reviewer, pr_state, review_status, posted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'laceyenterprises/agent-os',
    prNumber,
    '2026-07-27T00:00:00.000Z',
    'gemini',
    prState,
    reviewStatus,
    postedAt
  );
  return prNumber;
}

function seedReviewerPass(db, {
  prNumber,
  attemptNumber = 1,
  passKind = 'first-pass',
  endedAt = null,
  bodyCapturedAt = null,
  ghCommentId = null,
}) {
  db.prepare(
    `INSERT INTO reviewer_passes (
       repo, pr_number, attempt_number, reviewer_class, reviewer_model,
       pass_kind, started_at, ended_at, status, body_md, gh_comment_id,
       body_captured_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'laceyenterprises/agent-os',
    prNumber,
    attemptNumber,
    'gemini',
    'gemini',
    passKind,
    '2026-07-27T00:00:00.000Z',
    endedAt,
    'completed',
    ghCommentId ? 'review body' : null,
    ghCommentId,
    bodyCapturedAt
  );
}

test('parsePostedAtMs pins tz-less SQLite-style times to UTC', () => {
  // SQLite CURRENT_TIMESTAMP shape — must NOT be read as local time.
  assert.equal(parsePostedAtMs('2026-07-27 04:00:00'), Date.parse('2026-07-27T04:00:00Z'));
  // SQL-normalized T separator without an offset must also stay UTC.
  assert.equal(parsePostedAtMs('2026-07-27T04:00:00'), Date.parse('2026-07-27T04:00:00Z'));
  // ISO with explicit Z is unchanged.
  assert.equal(parsePostedAtMs('2026-07-27T04:00:00.500Z'), Date.parse('2026-07-27T04:00:00.500Z'));
  // Empty / non-string / garbage -> null (never NaN leaking into freshness math).
  assert.equal(parsePostedAtMs(''), null);
  assert.equal(parsePostedAtMs(null), null);
  assert.equal(parsePostedAtMs('not-a-date'), null);
});

test('latestPostedReviewAtMs returns the freshest genuine posted review artifact time', () => {
  withTempDb((db) => {
    assert.equal(latestPostedReviewAtMs(db), null, 'no posted rows -> null (detector seeds baseline)');
    seed(db, { prState: 'open', reviewStatus: 'pending', postedAt: null }); // awaiting, never posted
    const merged = seed(db, { prState: 'merged', reviewStatus: 'posted', postedAt: '2026-07-27T03:00:00.000Z' });
    const open = seed(db, { prState: 'open', reviewStatus: 'posted', postedAt: '2026-07-27 04:30:00' });
    seed(db, { prState: 'open', reviewStatus: 'failed', postedAt: null }); // failed pre-post: no posted artifact
    seedReviewerPass(db, {
      prNumber: merged,
      endedAt: '2026-07-27T03:00:00.000Z',
      ghCommentId: 'RV_merged',
    });
    seedReviewerPass(db, {
      prNumber: open,
      endedAt: '2026-07-27T04:00:00.000Z',
      bodyCapturedAt: '2026-07-27 04:30:00',
      ghCommentId: 'RV_open',
    }); // freshest
    assert.deepEqual(
      db.prepare(stmtLatestGenuinePostedReviewAt.source).all().map((row) => row.posted_at),
      ['2026-07-27 04:30:00', '2026-07-27T03:00:00.000Z']
    );
    assert.equal(latestPostedReviewAtMs(db), Date.parse('2026-07-27T04:30:00Z'));
  });
});

test('latestPostedReviewAtMs compares bounded mixed-precision candidates chronologically', () => {
  withTempDb((db) => {
    const withoutMillis = seed(db, {
      prState: 'open',
      reviewStatus: 'posted',
      postedAt: '2026-07-27T04:30:00Z',
    });
    const withMillis = seed(db, {
      prState: 'open',
      reviewStatus: 'posted',
      postedAt: '2026-07-27T04:30:00.500Z',
    });
    seedReviewerPass(db, {
      prNumber: withoutMillis,
      endedAt: '2026-07-27T04:30:00Z',
      ghCommentId: 'RV_without_millis',
    });
    seedReviewerPass(db, {
      prNumber: withMillis,
      endedAt: '2026-07-27T04:30:00.500Z',
      ghCommentId: 'RV_with_millis',
    });

    assert.deepEqual(
      db.prepare(stmtLatestGenuinePostedReviewAt.source).all().map((row) => row.posted_at),
      ['2026-07-27T04:30:00.500Z', '2026-07-27T04:30:00Z']
    );
    assert.equal(latestPostedReviewAtMs(db), Date.parse('2026-07-27T04:30:00.500Z'));
  });
});

test('latestPostedReviewAtMs uses the posted-review freshness index', () => {
  withTempDb((db) => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${stmtLatestGenuinePostedReviewAt.source}`).all();
    assert.match(
      plan.map((row) => row.detail).join('\n'),
      /idx_reviewer_passes_posted_review_freshness/
    );
  });
});

test('latestPostedReviewAtMs uses a bounded indexed candidate query, not an all-row scan', () => {
  withTempDb((db) => {
    const older = seed(db, {
      prState: 'merged',
      reviewStatus: 'posted',
      postedAt: '2026-07-27T03:00:00.000Z',
    });
    const fresher = seed(db, {
      prState: 'open',
      reviewStatus: 'posted',
      postedAt: '2026-07-27 04:30:00',
    });
    seedReviewerPass(db, {
      prNumber: older,
      endedAt: '2026-07-27T03:00:00.000Z',
      ghCommentId: 'RV_older',
    });
    seedReviewerPass(db, {
      prNumber: fresher,
      bodyCapturedAt: '2026-07-27 04:30:00',
      ghCommentId: 'RV_fresher',
    });

    const boundedHandle = {
      prepare(sql) {
        assert.match(sql, /LIMIT 64/);
        const stmt = db.prepare(sql);
        return {
          all: (...args) => stmt.all(...args),
        };
      },
    };

    assert.equal(latestPostedReviewAtMs(boundedHandle), Date.parse('2026-07-27T04:30:00Z'));
  });
});

test('countOpenPrsAwaitingFirstPassReview counts genuinely-open PRs with no posted review', () => {
  withTempDb((db) => {
    assert.equal(countOpenPrsAwaitingFirstPassReview(db), 0);
    seed(db, { prState: 'open', reviewStatus: 'pending' }); // counts
    seed(db, { prState: 'open', reviewStatus: 'reviewing' }); // counts
    seed(db, { prState: 'open', reviewStatus: 'pending-upstream' }); // counts (transient hold)
    const posted = seed(db, { prState: 'open', reviewStatus: 'posted', postedAt: '2026-07-27T03:00:00.000Z' }); // done
    seed(db, { prState: 'open', reviewStatus: 'posted' }); // masked status flip without real post still counts
    seed(db, { prState: 'open', reviewStatus: 'failed' }); // failed pre-post still has no posted_at, so counts
    seed(db, { prState: 'closed', reviewStatus: 'pending' }); // stale closed row must NOT cry wolf
    seed(db, { prState: 'merged', reviewStatus: 'reviewing' }); // merged row excluded
    seedReviewerPass(db, {
      prNumber: posted,
      endedAt: '2026-07-27T03:00:00.000Z',
      ghCommentId: 'RV_done',
    });
    assert.equal(countOpenPrsAwaitingFirstPassReview(db), 5);
  });
});

test('rereview post after posted_at reset advances freshness and does not count as first-pass awaiting', () => {
  withTempDb((db) => {
    const churning = seed(db, {
      prState: 'open',
      reviewStatus: 'reviewing',
      postedAt: null,
    });
    seedReviewerPass(db, {
      prNumber: churning,
      attemptNumber: 1,
      passKind: 'first-pass',
      endedAt: '2026-08-10T20:28:04.000Z',
      ghCommentId: 'RV_5177_first',
    });
    seedReviewerPass(db, {
      prNumber: churning,
      attemptNumber: 2,
      passKind: 'rereview',
      endedAt: '2026-08-10T20:39:22.000Z',
      ghCommentId: 'RV_5177_rereview',
    });

    assert.equal(latestPostedReviewAtMs(db), Date.parse('2026-08-10T20:39:22.000Z'));
    assert.equal(countOpenPrsAwaitingFirstPassReview(db), 0);
  });
});

test('masked posted status without gh_comment_id does not advance freshness or hide awaiting count', () => {
  withTempDb((db) => {
    const masked = seed(db, {
      prState: 'open',
      reviewStatus: 'posted',
      postedAt: '2026-08-10T20:00:00.000Z',
    });
    seedReviewerPass(db, {
      prNumber: masked,
      endedAt: '2026-08-10T20:00:00.000Z',
      ghCommentId: null,
    });

    assert.equal(latestPostedReviewAtMs(db), null);
    assert.equal(countOpenPrsAwaitingFirstPassReview(db), 1);
  });
});

test('RVFRESH-01 repro: posted_at reset plus rereview post keeps freshness quiet', async () => {
  await withTempDbAsync(async (db) => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'review-freshness-state-'));
    try {
      const old = seed(db, {
        prState: 'merged',
        reviewStatus: 'posted',
        postedAt: '2026-08-10T19:55:00.000Z',
      });
      const churning = seed(db, {
        prState: 'open',
        reviewStatus: 'reviewing',
        postedAt: null,
      });
      seed(db, {
        prState: 'open',
        reviewStatus: 'pending',
        postedAt: null,
      });
      seedReviewerPass(db, {
        prNumber: old,
        endedAt: '2026-08-10T19:55:00.000Z',
        ghCommentId: 'RV_5176_old',
      });
      seedReviewerPass(db, {
        prNumber: churning,
        attemptNumber: 2,
        passKind: 'rereview',
        endedAt: '2026-08-10T20:39:22.000Z',
        ghCommentId: 'RV_5177_rereview',
      });

      const calls = [];
      const res = await maybeFireReviewStalledAlert({
        deliverAlertFn: async (text, structured) => calls.push([text, structured]),
        now: Date.parse('2026-08-10T20:48:00.000Z'),
        pendingReviewCount: countOpenPrsAwaitingFirstPassReview(db),
        lastPostedReviewMs: latestPostedReviewAtMs(db),
        stateDir,
      });

      assert.equal(countOpenPrsAwaitingFirstPassReview(db), 1);
      assert.equal(res.fired, false);
      assert.equal(res.reason, 'reviews fresh');
      assert.equal(calls.length, 0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

test('genuinely starved open PR still pages when no recent gh_comment_id exists', async () => {
  await withTempDbAsync(async (db) => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'review-freshness-state-'));
    try {
      const old = seed(db, {
        prState: 'merged',
        reviewStatus: 'posted',
        postedAt: '2026-08-10T19:55:00.000Z',
      });
      seed(db, {
        prState: 'open',
        reviewStatus: 'pending',
        postedAt: null,
      });
      seedReviewerPass(db, {
        prNumber: old,
        endedAt: '2026-08-10T19:55:00.000Z',
        ghCommentId: 'RV_old',
      });

      const calls = [];
      const res = await maybeFireReviewStalledAlert({
        deliverAlertFn: async (text, structured) => calls.push([text, structured]),
        now: Date.parse('2026-08-10T20:48:00.000Z'),
        pendingReviewCount: countOpenPrsAwaitingFirstPassReview(db),
        lastPostedReviewMs: latestPostedReviewAtMs(db),
        stateDir,
      });

      assert.equal(res.fired, true);
      assert.equal(calls.length, 1);
      assert.match(calls[0][0], /No review posted for 53m/);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

test('healthy remediation churn stays quiet across the freshness window', async () => {
  await withTempDbAsync(async (db) => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'review-freshness-state-'));
    try {
      const pr = seed(db, {
        prState: 'open',
        reviewStatus: 'reviewing',
        postedAt: null,
      });
      const calls = [];
      for (let i = 0; i < 4; i += 1) {
        const postedAtMs = Date.parse('2026-08-10T20:00:00.000Z') + i * 10 * 60 * 1000;
        seedReviewerPass(db, {
          prNumber: pr,
          attemptNumber: i + 1,
          passKind: i === 0 ? 'first-pass' : 'rereview',
          endedAt: new Date(postedAtMs).toISOString(),
          ghCommentId: `RV_churn_${i}`,
        });
        const res = await maybeFireReviewStalledAlert({
          deliverAlertFn: async (text, structured) => calls.push([text, structured]),
          now: postedAtMs + REVIEW_STALL_THRESHOLD_MS - 1,
          pendingReviewCount: 1,
          lastPostedReviewMs: latestPostedReviewAtMs(db),
          stateDir,
        });
        assert.equal(res.fired, false);
      }
      assert.equal(calls.length, 0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

for (const [reviewMinutes, waitMinutes, fired] of [[120, 2, false], [120, 70, true], [10, 180, false], [120, null, true]]) {
  test(`waiting admission timestamp wiring: ${reviewMinutes}/${waitMinutes}`, async () => {
    await withTempDbAsync(async db => {
      const now = Date.parse('2026-10-01T12:00:00Z');
      const waiting = seed(db, { prState: 'open', reviewStatus: 'pending' });
      db.prepare('UPDATE reviewed_prs SET reviewed_at = ? WHERE pr_number = ?').run(
        waitMinutes === null ? 'unreadable' : new Date(now - waitMinutes * 60000).toISOString(), waiting);
      const posted = seed(db, { prState: 'merged', reviewStatus: 'posted' });
      seedReviewerPass(db, { prNumber: posted, ghCommentId: 'synthetic-review',
        endedAt: new Date(now - reviewMinutes * 60000).toISOString() });
      const calls = [];
      const result = await maybeFireReviewStalledAlert({ now,
        pendingReviewCount: countOpenPrsAwaitingFirstPassReview(db),
        oldestPendingSinceMs: oldestOpenPrAwaitingFirstPassReviewAtMs(db),
        lastPostedReviewMs: latestPostedReviewAtMs(db), stallThresholdMs: 60 * 60000,
        fsImpl: { readFileSync() { throw new Error('missing'); }, existsSync() { return true; }, writeFileSync() {} },
        deliverAlertFn: async (text, meta) => calls.push({ text, meta }),
      });
      assert.equal(result.fired, fired);
      if (fired && waitMinutes !== null) {
        assert.match(calls[0].text, /for 70m/);
        assert.equal(calls[0].meta.payload.oldest_pending_since, new Date(now - waitMinutes * 60000).toISOString());
      }
    });
  });
}

test('oldest waiting timestamp shares the first-pass count exclusions and normalizes dates', () => {
  withTempDb(db => {
    const first = seed(db, { prState: 'open', reviewStatus: 'pending' });
    const second = seed(db, { prState: 'open', reviewStatus: 'reviewing' });
    db.prepare('UPDATE reviewed_prs SET reviewed_at = ? WHERE pr_number = ?').run('2026-10-01 10:00:00', first);
    db.prepare('UPDATE reviewed_prs SET reviewed_at = ? WHERE pr_number = ?').run('2026-10-01T08:00:00-01:00', second);
    seed(db, { prState: 'closed', reviewStatus: 'pending' });
    seed(db, { prState: 'open', reviewStatus: 'malformed' });
    const posted = seed(db, { prState: 'open', reviewStatus: 'posted' });
    seedReviewerPass(db, { prNumber: posted, ghCommentId: 'synthetic-posted' });
    assert.equal(countOpenPrsAwaitingFirstPassReview(db), 2);
    assert.equal(oldestOpenPrAwaitingFirstPassReviewAtMs(db), Date.parse('2026-10-01T09:00:00Z'));
  });
  assert.equal(oldestOpenPrAwaitingFirstPassReviewAtMs({ prepare() { throw new Error('unreadable'); } }), null);
});

test('invalid admission rows do not hide valid waiting timestamps', async () => {
  await withTempDbAsync(async db => {
    const valid = seed(db, { prState: 'open', reviewStatus: 'pending' });
    db.prepare('UPDATE reviewed_prs SET reviewed_at = ? WHERE pr_number = ?').run('2026-10-01T11:58:00Z', valid);
    for (const stamp of ['', 'unreadable']) {
      const invalid = seed(db, { prState: 'open', reviewStatus: 'pending' });
      db.prepare('UPDATE reviewed_prs SET reviewed_at = ? WHERE pr_number = ?').run(stamp, invalid);
    }
    const oldestPendingSinceMs = oldestOpenPrAwaitingFirstPassReviewAtMs(db);
    assert.equal(oldestPendingSinceMs, Date.parse('2026-10-01T11:58:00Z'));
    const result = await maybeFireReviewStalledAlert({ now: Date.parse('2026-10-01T12:00:00Z'),
      pendingReviewCount: countOpenPrsAwaitingFirstPassReview(db), oldestPendingSinceMs,
      lastPostedReviewMs: Date.parse('2026-10-01T09:00:00Z'), stallThresholdMs: 60 * 60000,
      deliverAlertFn: async () => assert.fail('fresh admissions must suppress premature stall alerts') });
    assert.equal(result.fired, false);
    db.prepare('DELETE FROM reviewed_prs WHERE pr_number = ?').run(valid);
    assert.equal(oldestOpenPrAwaitingFirstPassReviewAtMs(db), null);
  });
});
