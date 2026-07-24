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
  countReviewCeilingUnits,
} from '../src/watcher.mjs';

function makeTempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'review-dedup-ceiling-'));
}

function insertPass(db, { repoPath, prNumber, attemptNumber, passKind, headSha, status = 'completed' }) {
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
      insertPass(db, { repoPath, prNumber, attemptNumber, passKind: 'rereview', headSha: head });
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
    insertPass(db, { repoPath, prNumber, attemptNumber: 1, passKind: 'first-pass', headSha: 'aaaa1111' });
    insertPass(db, { repoPath, prNumber, attemptNumber: 2, passKind: 'rereview', headSha: 'bbbb2222' });
    insertPass(db, { repoPath, prNumber, attemptNumber: 3, passKind: 'rereview', headSha: 'bbbb2222' }); // dup of head B
    insertPass(db, { repoPath, prNumber, attemptNumber: 4, passKind: 'rereview', headSha: 'cccc3333' });
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
    insertPass(db, { repoPath, prNumber, attemptNumber: 1, passKind: 'rereview', headSha: 'dddd4444', status: 'failed' });
    insertPass(db, { repoPath, prNumber, attemptNumber: 2, passKind: 'rereview', headSha: null });
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
    insertPass(db, { repoPath, prNumber, attemptNumber: 1, passKind: 'first-pass', headSha: 'eeee5555' });
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
    insertPass(db, { repoPath, prNumber, attemptNumber: 1, passKind: 'rereview', headSha: 'ffff6666' });
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

    insertPass(db, { repoPath, prNumber, attemptNumber: 1, passKind: 'rereview', headSha: completedHead });
    insertPass(db, { repoPath, prNumber, attemptNumber: 2, passKind: 'rereview', headSha: completedHead });
    insertPass(db, {
      repoPath,
      prNumber,
      attemptNumber: 3,
      passKind: 'rereview',
      headSha: failingHead,
      status: 'failed',
    });
    insertPass(db, {
      repoPath,
      prNumber,
      attemptNumber: 4,
      passKind: 'rereview',
      headSha: failingHead,
      status: 'failed',
    });
    insertPass(db, {
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
        currentHeadSha: failingHead,
        fallbackReviewAttempts: 99,
      }),
      1,
      'one completed head is one landed review; failed passes are attempt evidence but not reviews',
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

    insertPass(db, {
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
        currentHeadSha: failingHead,
        fallbackReviewAttempts: 7,
      }),
      0,
      'a modern failed-only pass is attempt evidence, not a landed review',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('ceiling units preserve legacy null-head history and empty-ledger fallback', () => {
  const rootDir = makeTempRoot();
  try {
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    const repoPath = 'laceyenterprises/agent-os';
    const prNumber = 3904;

    insertPass(db, { repoPath, prNumber, attemptNumber: 1, passKind: 'rereview', headSha: null });
    assert.equal(
      countReviewCeilingUnits({
        db,
        rootDir,
        repoPath,
        prNumber,
        currentHeadSha: '5555eeee',
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
        currentHeadSha: '6666ffff',
        fallbackReviewAttempts: 4,
      }),
      4,
      'an empty reviewer_passes ledger falls back to the durable reviewed_prs attempt counter',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
