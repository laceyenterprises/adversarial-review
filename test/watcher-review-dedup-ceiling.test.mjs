/* REVIEW-DEDUP — the hard re-review ceiling counts DISTINCT reviewed head SHAs.
 *
 * Live evidence 2026-07-13: agent-os PR #3655 got FOUR reviews of ONE unchanged
 * commit. Each attempt bumped `reviewed_prs.review_attempts`, so keying the hard
 * ceiling on that event counter let one real round plus its duplicates trip the
 * cap and deadlock the PR. `countDistinctReviewedHeadShas` collapses duplicates
 * of a single head to one, so duplicates cost nothing against the ceiling while
 * genuine head churn is still bounded.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import {
  countCompletedReviewerRereviewRounds,
  countDistinctReviewedHeadShas,
  countReviewCeilingAttempts,
  countReviewCeilingUnits,
} from '../src/watcher.mjs';

function makeTempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'review-dedup-ceiling-'));
}

function insertPass(
  db,
  { repoPath, prNumber, attemptNumber, passKind, headSha, status = 'completed', metadata = {}, postedId = null }
) {
  db.prepare(
    `INSERT INTO reviewer_passes (
       repo, pr_number, attempt_number, reviewer_class, reviewer_model, pass_kind,
       started_at, ended_at, status, head_sha, metadata_json
     ) VALUES (?, ?, ?, 'gemini', 'gemini', ?, ?, ?, ?, ?, '{}')`
  ).run(
    repoPath,
    prNumber,
    attemptNumber,
    passKind,
    `2026-07-13T00:0${attemptNumber}:00.000Z`,
    `2026-07-13T00:0${attemptNumber}:30.000Z`,
    status,
    headSha,
  );
  if (postedId !== null) db.prepare('UPDATE reviewer_passes SET gh_comment_id=? WHERE repo=? AND pr_number=? AND attempt_number=?')
    .run(`${postedId}-${attemptNumber}`, repoPath, prNumber, attemptNumber);
  db.prepare(
    `UPDATE reviewer_passes
        SET metadata_json = ?
      WHERE repo = ?
        AND pr_number = ?
        AND attempt_number = ?
        AND pass_kind = ?`
  ).run(
    JSON.stringify(metadata),
    repoPath,
    prNumber,
    attemptNumber,
    passKind,
  );
}

test('duplicate completed reviews of one head count as a single distinct head', () => {
  const rootDir = makeTempRoot();
  try {
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    const repoPath = 'laceyenterprises/agent-os';
    const prNumber = 3655;
    const head = '316e2513d000';
    // The live pathology: four completed reviews, all on the same head.
    for (const attemptNumber of [1, 2, 3, 4]) {
      insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber, passKind: 'rereview', headSha: head });
    }
    assert.equal(
      countDistinctReviewedHeadShas({ db, rootDir, repoPath, prNumber }),
      1,
      'four duplicate reviews of one head are one distinct reviewed head',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('genuine head churn increments the distinct-head count', () => {
  const rootDir = makeTempRoot();
  try {
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    const repoPath = 'laceyenterprises/agent-os';
    const prNumber = 3700;
    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 1, passKind: 'first-pass', headSha: 'aaaa1111' });
    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 2, passKind: 'rereview', headSha: 'bbbb2222' });
    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 3, passKind: 'rereview', headSha: 'bbbb2222' }); // dup of head B
    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 4, passKind: 'rereview', headSha: 'cccc3333' });
    assert.equal(
      countDistinctReviewedHeadShas({ db, rootDir, repoPath, prNumber }),
      3,
      'heads A, B, C — the duplicate of B does not add a fourth',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('non-completed and null-head passes never count toward the distinct-head ceiling', () => {
  const rootDir = makeTempRoot();
  try {
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    const repoPath = 'laceyenterprises/agent-os';
    const prNumber = 3800;
    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 1, passKind: 'rereview', headSha: 'dddd4444', status: 'failed' });
    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 2, passKind: 'rereview', headSha: null });
    assert.equal(
      countDistinctReviewedHeadShas({ db, rootDir, repoPath, prNumber }),
      0,
      'a failed pass and a null-head legacy pass are not distinct reviewed heads',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('distinct-head counter owned-db path closes without ReferenceError', () => {
  const rootDir = makeTempRoot();
  try {
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    const repoPath = 'laceyenterprises/agent-os';
    const prNumber = 3900;
    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 1, passKind: 'first-pass', headSha: 'eeee5555' });
    db.close();

    assert.equal(
      countDistinctReviewedHeadShas({ rootDir, repoPath, prNumber }),
      1,
      'owned-db cleanup must not reference an undefined injected db variable',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('completed-rereview counter owned-db path closes without ReferenceError', () => {
  const rootDir = makeTempRoot();
  try {
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    const repoPath = 'laceyenterprises/agent-os';
    const prNumber = 3901;
    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 1, passKind: 'rereview', headSha: 'ffff6666' });
    db.close();

    assert.equal(
      countCompletedReviewerRereviewRounds({ rootDir, repoPath, prNumber }),
      1,
      'owned-db cleanup must not reference an undefined injected db variable',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('ceiling units collapse duplicate completions and ignore non-landed failures', () => {
  const rootDir = makeTempRoot();
  try {
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    const repoPath = 'laceyenterprises/agent-os';
    const prNumber = 3902;
    const completedHead = '1111aaaa';
    const failingHead = '2222bbbb';

    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 1, passKind: 'rereview', headSha: completedHead });
    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 2, passKind: 'rereview', headSha: completedHead });
    insertPass(db, { postedId: 'delivered',
      repoPath,
      prNumber,
      attemptNumber: 3,
      passKind: 'rereview',
      headSha: failingHead,
      status: 'failed',
    });
    insertPass(db, { postedId: 'delivered',
      repoPath,
      prNumber,
      attemptNumber: 4,
      passKind: 'rereview',
      headSha: failingHead,
      status: 'failed',
    });
    insertPass(db, { postedId: 'delivered',
      repoPath,
      prNumber,
      attemptNumber: 5,
      passKind: 'rereview',
      headSha: '3333cccc',
      status: 'failed',
    });

    assert.equal(
      countReviewCeilingUnits({
        db,
        rootDir,
        repoPath,
        prNumber,
        fallbackReviewAttempts: 99,
      }),
      1,
      'one completed head is one landed review; failed passes are attempt evidence but not reviews',
    );
    assert.equal(
      countReviewCeilingAttempts({
        db,
        rootDir,
        repoPath,
        prNumber,
        fallbackReviewAttempts: 99,
      }),
      5,
      'the independent attempt fuse still counts failed and duplicate reviewer attempts',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('stale-head passes do not spend either current-head reviewer ceiling', () => {
  const rootDir = makeTempRoot();
  try {
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    const repoPath = 'laceyenterprises/adversarial-review';
    const prNumber = 802;
    const currentHead = 'post-remediation-head';

    // Two stale comment-only reviews and one stale blocking review are useful
    // audit history, but cannot deny the exact-head review of the remediation.
    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 1, passKind: 'first-pass', headSha: 'first-head' });
    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 2, passKind: 'rereview', headSha: 'middle-head' });
    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 3, passKind: 'rereview', headSha: 'blocking-head' });
    insertPass(db, { postedId: 'delivered',
      repoPath,
      prNumber,
      attemptNumber: 4,
      passKind: 'rereview',
      headSha: 'blocking-head',
      status: 'failed',
      metadata: { failureClass: 'reviewer-timeout' },
    });

    assert.equal(
      countReviewCeilingUnits({
        db,
        rootDir,
        repoPath,
        prNumber,
        headSha: currentHead,
        fallbackReviewAttempts: 99,
      }),
      0,
      'stale landed reviews and the PR-wide legacy counter cannot consume the current head budget',
    );
    assert.equal(
      countReviewCeilingAttempts({
        db,
        rootDir,
        repoPath,
        prNumber,
        headSha: currentHead,
        fallbackReviewAttempts: 99,
      }),
      0,
      'a stale timeout cannot trip the independent fuse for the current head',
    );

    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 5, passKind: 'rereview', headSha: currentHead });
    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 6, passKind: 'rereview', headSha: currentHead });
    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 7, passKind: 'rereview', headSha: currentHead });
    assert.equal(
      countReviewCeilingUnits({ db, rootDir, repoPath, prNumber, headSha: currentHead }),
      3,
      'each completed current-head review consumes a ceiling unit so the same-head circuit breaker still trips',
    );
    assert.equal(
      countReviewCeilingAttempts({ db, rootDir, repoPath, prNumber, headSha: currentHead }),
      3,
      'the same-head attempt fuse remains bounded even though historical heads are ignored',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('ceiling units do not fall back to raw attempts for modern failed-only passes', () => {
  const rootDir = makeTempRoot();
  try {
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    const repoPath = 'laceyenterprises/agent-os';
    const prNumber = 3903;
    const failingHead = '4444dddd';

    insertPass(db, { postedId: 'delivered',
      repoPath,
      prNumber,
      attemptNumber: 1,
      passKind: 'rereview',
      headSha: failingHead,
      status: 'failed',
    });

    assert.equal(
      countReviewCeilingUnits({
        db,
        rootDir,
        repoPath,
        prNumber,
        fallbackReviewAttempts: 7,
      }),
      0,
      'a modern failed-only pass is attempt evidence, not a landed review',
    );
    assert.equal(
      countReviewCeilingAttempts({
        db,
        rootDir,
        repoPath,
        prNumber,
        fallbackReviewAttempts: 7,
      }),
      1,
      'the independent attempt fuse still sees modern failed-only attempts',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('ceiling units preserve legacy posted history but attempts without a pass spend nothing', () => {
  const rootDir = makeTempRoot();
  try {
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    const repoPath = 'laceyenterprises/agent-os';
    const prNumber = 3904;

    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 1, passKind: 'rereview', headSha: null });
    assert.equal(
      countReviewCeilingUnits({
        db,
        rootDir,
        repoPath,
        prNumber,
        fallbackReviewAttempts: 4,
      }),
      1,
      'a legacy null-head pass still consumes one bounded ceiling unit',
    );

    assert.equal(
      countReviewCeilingUnits({
        db,
        rootDir,
        repoPath,
        prNumber: 3905,
        fallbackReviewAttempts: 4,
      }),
      0,
      'an empty reviewer_passes ledger proves no posted review',
    );
    assert.equal(
      countReviewCeilingAttempts({
        db,
        rootDir,
        repoPath,
        prNumber: 3905,
        fallbackReviewAttempts: 4,
      }),
      4,
      'empty attempt ledgers also fall back to the durable reviewed_prs attempt counter',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('transient fleet-infra failures do not consume the review-attempt ceiling', () => {
  const rootDir = makeTempRoot();
  try {
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    const repoPath = 'laceyenterprises/agent-os';
    const prNumber = 4313;

    for (const [attemptNumber, failureClass] of [
      [1, 'adapter_spawn_timeout'],
      [2, 'dispatch-failed'],
      [3, 'launchctl-bootstrap'],
      [4, 'oauth-broken'],
    ]) {
      insertPass(db, { postedId: 'delivered',
        repoPath,
        prNumber,
        attemptNumber,
        passKind: 'rereview',
        headSha: `infra-${attemptNumber}`,
        status: 'failed',
        metadata: { failureClass },
      });
    }

    assert.equal(
      countReviewCeilingAttempts({
        db,
        rootDir,
        repoPath,
        prNumber,
        fallbackReviewAttempts: 99,
      }),
      0,
      'outage retries are not review attempts and must not ceiling-freeze the PR',
    );

    insertPass(db, { postedId: 'delivered',
      repoPath,
      prNumber,
      attemptNumber: 5,
      passKind: 'rereview',
      headSha: 'recovered-head',
      status: 'completed',
    });
    assert.equal(
      countReviewCeilingAttempts({
        db,
        rootDir,
        repoPath,
        prNumber,
        fallbackReviewAttempts: 99,
      }),
      1,
      'the next real review still runs once the fleet recovers',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('deterministic crash, timeout, and genuine review failures still consume the attempt fuse', () => {
  const rootDir = makeTempRoot();
  try {
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    const repoPath = 'laceyenterprises/agent-os';
    const prNumber = 4314;

    insertPass(db, { postedId: 'delivered',
      repoPath,
      prNumber,
      attemptNumber: 1,
      passKind: 'first-pass',
      headSha: 'worker-crash',
      status: 'failed',
      metadata: { failureClass: 'worker_crashed' },
    });
    insertPass(db, { postedId: 'delivered',
      repoPath,
      prNumber,
      attemptNumber: 2,
      passKind: 'rereview',
      headSha: 'timeout-head',
      status: 'failed',
      metadata: { failureClass: 'reviewer-timeout' },
    });
    insertPass(db, { postedId: 'delivered',
      repoPath,
      prNumber,
      attemptNumber: 3,
      passKind: 'rereview',
      headSha: 'request-changes-head',
      status: 'completed',
    });

    assert.equal(
      countReviewCeilingAttempts({
        db,
        rootDir,
        repoPath,
        prNumber,
      }),
      3,
      'deterministic per-PR failures and genuine review attempts must still trip the fuse',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('HAMCLOSE-02 a completed process with no posted review ID consumes no review ceiling unit', () => {
  const rootDir = makeTempRoot();
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const repoPath = 'fixture/repo', prNumber = 8143, headSha = 'b'.repeat(40);
    insertPass(db, { postedId: 'delivered', repoPath, prNumber, attemptNumber: 1, passKind: 'rereview', headSha });
    db.prepare('UPDATE reviewer_passes SET gh_comment_id=NULL WHERE repo=? AND pr_number=?').run(repoPath, prNumber);
    for (const head of [null, headSha]) assert.equal(countReviewCeilingUnits({ db, rootDir, repoPath,
      prNumber, headSha: head, fallbackReviewAttempts: 3 }), 0);
  } finally { db.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test('one delivered head and three undelivered completions spend exactly one and zero units', () => {
  const rootDir = makeTempRoot(), db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const repoPath = 'fixture/repo', prNumber = 1, a = 'a'.repeat(40), b = 'b'.repeat(40);
    insertPass(db, { repoPath, prNumber, attemptNumber: 1, passKind: 'first-pass', headSha: a, postedId: 'delivered' });
    for (const attemptNumber of [2,3,4]) insertPass(db, { repoPath, prNumber, attemptNumber, passKind: 'rereview', headSha: b });
    assert.equal(countReviewCeilingUnits({ db, repoPath, prNumber, headSha: a }), 1);
    assert.equal(countReviewCeilingUnits({ db, repoPath, prNumber, headSha: b }), 0);
    assert.equal(countReviewCeilingUnits({ db, repoPath, prNumber }), 1);
    db.prepare("UPDATE reviewer_passes SET body_md='Stored review' WHERE attempt_number=2").run();
    assert.equal(countReviewCeilingUnits({ db, repoPath, prNumber, headSha: b }), 1);
    db.prepare(`UPDATE reviewer_passes SET metadata_json=? WHERE attempt_number=3`).run(JSON.stringify({ reviewBodyCapture: { status: 'verified-github-artifact' } }));
    assert.equal(countReviewCeilingUnits({ db, repoPath, prNumber, headSha: b }), 2);
    db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,review_status,review_attempts) VALUES (?,2,'2026-01-01','gemini','posted',3)`).run(repoPath);
    assert.equal(countReviewCeilingUnits({ db, repoPath, prNumber: 2 }), 3);
  } finally { db.close(); rmSync(rootDir, { recursive: true, force: true }); }
});
