// quota-rearm-cli.test.mjs — proves the operator re-arm (bin/quota-rearm.mjs)
// clears a stuck quota-held / quota-exhausted reviewer row so the watcher
// re-reviews it on the next poll. Mirrors the dispatch-lane `hq fleet quota
// nudge`.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { ensureReviewStateSchema } from '../src/review-state.mjs';
import {
  isQuotaRearmEligible,
  main,
  planQuotaRearm,
  rearmQuotaReview,
} from '../bin/quota-rearm.mjs';

const REPO = 'laceyenterprises/agent-os';
const PR = 2429;

function setupRow(overrides = {}) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'quota-rearm-'));
  mkdirSync(path.join(rootDir, 'data'), { recursive: true });
  const db = new Database(path.join(rootDir, 'data', 'reviews.db'));
  ensureReviewStateSchema(db);
  const row = {
    pr_state: 'open',
    review_status: 'failed',
    review_attempts: 2,
    infra_auto_recover_attempts: 3,
    failed_at: '2026-06-17T17:30:00.000Z',
    failure_message: '[quota-exhausted] Command failed with code 1\nstdout tail:...',
    quota_reset_at_utc: '2026-06-18T00:39:00.000Z',
    ...overrides,
  };
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts,
        infra_auto_recover_attempts, failed_at, failure_message, quota_reset_at_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    REPO, PR, '2026-06-17T17:00:00.000Z', 'codex',
    row.pr_state, row.review_status, row.review_attempts,
    row.infra_auto_recover_attempts, row.failed_at, row.failure_message, row.quota_reset_at_utc
  );
  db.close();
  return rootDir;
}

function readRow(rootDir) {
  const db = new Database(path.join(rootDir, 'data', 'reviews.db'), { readonly: true });
  try {
    return db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(REPO, PR);
  } finally {
    db.close();
  }
}

// --- pure predicate / plan tests ---

test('isQuotaRearmEligible: quota-tagged failure_message qualifies', () => {
  assert.equal(isQuotaRearmEligible({ failure_message: '[quota-exhausted] x' }), true);
});

test('isQuotaRearmEligible: a stored quota_reset_at_utc qualifies even if the message was nulled', () => {
  assert.equal(isQuotaRearmEligible({ failure_message: null, quota_reset_at_utc: '2026-06-18T00:39:00Z' }), true);
});

test('isQuotaRearmEligible: a non-quota failure does NOT qualify (but --force does)', () => {
  const row = { failure_message: '[unknown] command failed with code 1' };
  assert.equal(isQuotaRearmEligible(row), false);
  assert.equal(isQuotaRearmEligible(row, { force: true }), true);
});

test('planQuotaRearm refuses a missing / closed / in-flight row', () => {
  assert.equal(planQuotaRearm(null).action, 'refuse');
  assert.equal(planQuotaRearm({ pr_state: 'merged', review_status: 'failed' }).reason, 'pr-not-open');
  assert.equal(planQuotaRearm({ pr_state: 'open', review_status: 'reviewing' }).reason, 'reviewing');
});

test('planQuotaRearm is a no-op when already pending', () => {
  const plan = planQuotaRearm({ pr_state: 'open', review_status: 'pending' });
  assert.equal(plan.action, 'noop-already-pending');
});

// --- end-to-end re-arm against a real db ---

test('re-arm clears the quota hold state and resets the infra auto-recover budget', () => {
  const rootDir = setupRow();
  try {
    const result = rearmQuotaReview({ rootDir, repo: REPO, prNumber: PR });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'rearm');

    const row = readRow(rootDir);
    assert.equal(row.review_status, 'pending');
    assert.equal(row.failed_at, null);
    assert.equal(row.failure_message, null);
    assert.equal(row.quota_reset_at_utc, null);
    assert.equal(row.infra_auto_recover_attempts, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('re-arm refuses a non-quota row without --force, allows it with --force', () => {
  const rootDir = setupRow({
    failure_message: '[unknown] command failed with code 1',
    quota_reset_at_utc: null,
  });
  try {
    const refused = rearmQuotaReview({ rootDir, repo: REPO, prNumber: PR });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'not-a-quota-row');
    assert.equal(readRow(rootDir).review_status, 'failed', 'row must be untouched on refusal');

    const forced = rearmQuotaReview({ rootDir, repo: REPO, prNumber: PR, force: true });
    assert.equal(forced.ok, true);
    assert.equal(readRow(rootDir).review_status, 'pending');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('re-arm refuses a row with a reviewer in flight (does not clobber the live attempt)', () => {
  const rootDir = setupRow({ review_status: 'reviewing' });
  try {
    const result = rearmQuotaReview({ rootDir, repo: REPO, prNumber: PR });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'reviewing');
    assert.equal(readRow(rootDir).review_status, 'reviewing');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('CLI main() exits 0 with --json on a successful re-arm', () => {
  const rootDir = setupRow();
  try {
    let out = '';
    let err = '';
    const code = main(['--repo', REPO, '--pr', String(PR), '--json', '--root-dir', rootDir], {
      stdout: { write: (s) => { out += s; } },
      stderr: { write: (s) => { err += s; } },
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.action, 'rearm');
    assert.equal(parsed.reviewStatus, 'pending');
    assert.equal(err, '');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('CLI main() exits 1 (refused) for a non-quota row without --force', () => {
  const rootDir = setupRow({ failure_message: '[unknown] x', quota_reset_at_utc: null });
  try {
    let out = '';
    const code = main(['--repo', REPO, '--pr', String(PR), '--json', '--root-dir', rootDir], {
      stdout: { write: (s) => { out += s; } },
      stderr: { write: () => {} },
    });
    assert.equal(code, 1);
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'not-a-quota-row');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('CLI main() exits 2 on usage error (missing --pr)', () => {
  let err = '';
  const code = main(['--repo', REPO], {
    stdout: { write: () => {} },
    stderr: { write: (s) => { err += s; } },
  });
  assert.equal(code, 2);
  assert.match(err, /--repo and --pr are required/);
});
