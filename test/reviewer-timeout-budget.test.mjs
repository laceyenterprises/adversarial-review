import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { reapRunningPassTimeouts } from '../src/reviewer-pass-reaper.mjs';
import { recordCascadeFailure, readCascadeState } from '../src/reviewer-cascade.mjs';
import { reviewerBuildDigest, reviewerTimeoutBudget, resolveReviewerTimeoutSameHeadLimit } from '../src/reviewer-timeout-budget.mjs';

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'timeout-budget-'));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
const identity = { repo: 'example/review-service', prNumber: 1 };
const scope = { headSha: 'head-a', reviewerBuildId: 'build-a' };
function timeout(root, extra = {}) {
  return recordCascadeFailure(root, { ...identity, ...scope, failureClass: 'reviewer-timeout',
    failedAt: '2026-01-01T00:00:00Z', ...extra });
}

test('CASCADECAP-01 timeout budget binds to head/build and gives a changed build exactly one attempt', () => fixture(root => {
  timeout(root);
  const state = timeout(root);
  assert.equal(reviewerTimeoutBudget(state, scope).parked, true);
  assert.equal(reviewerTimeoutBudget(state, { ...scope, headSha: 'head-b' }).parked, false);
  const probe = reviewerTimeoutBudget(state, { ...scope, reviewerBuildId: 'build-b' });
  assert.equal(probe.count, 0);
  assert.equal(probe.limit, 1);
  assert.equal(probe.total, 2, 'build changes retain seat fairness');
  timeout(root, { reviewerBuildId: 'build-b' });
  assert.equal(reviewerTimeoutBudget(readCascadeState(root, identity), { ...scope, reviewerBuildId: 'build-b' }).parked, true);
  const fresh = timeout(root, { headSha: 'head-b', reviewerBuildId: 'build-b' });
  assert.equal(reviewerTimeoutBudget(fresh, { headSha: 'head-b', reviewerBuildId: 'build-b' }).parked, false);
  assert.equal(fresh.reviewerTimeout.count, 1);
}));

test('CASCADECAP-01 operator re-arm gives one probe, while automatic requests cannot reset timeout accounting', () => fixture(root => {
  timeout(root);
  const state = timeout(root);
  const row = { rereview_reason: 'retrigger-review: synthetic operator request', rereview_requested_at: '2026-01-02T00:00:00Z' };
  assert.equal(reviewerTimeoutBudget(state, { ...scope, row }).parked, false);
  assert.equal(reviewerTimeoutBudget(state, { ...scope, row: { ...row, rereview_reason: 'automatic rereview' } }).parked, true);
  const probe = timeout(root, { row, failedAt: '2026-01-02T00:01:00Z' });
  assert.equal(reviewerTimeoutBudget(probe, { ...scope, row }).parked, true);
  assert.equal(probe.reviewerTimeout.limit, 1);
}));

test('CASCADECAP-01 timeout history survives other transients and legacy files fail closed on the failed head', () => fixture(root => {
  timeout(root);
  timeout(root);
  const state = recordCascadeFailure(root, { ...identity, failureClass: 'cascade', failedAt: '2026-01-01T01:00:00Z' });
  assert.equal(reviewerTimeoutBudget(state, scope).parked, true);
  const legacy = { transientFailureBreakdown: { 'reviewer-timeout': 5 } };
  assert.equal(reviewerTimeoutBudget(legacy, { ...scope, row: { reviewer_head_sha: scope.headSha } }).parked, true);
  assert.equal(reviewerTimeoutBudget(legacy, { ...scope, row: { reviewer_head_sha: 'older-head' } }).parked, false);
}));

test('CASCADECAP-01 timeout limit has a positive integer environment override', () => {
  for (const input of [undefined, '', '0', '-1', 'invalid', 'Infinity', '1.5']) {
    assert.equal(resolveReviewerTimeoutSameHeadLimit({ ADVERSARIAL_REVIEWER_TIMEOUT_SAME_HEAD_LIMIT: input }), 2);
  }
  assert.equal(resolveReviewerTimeoutSameHeadLimit({ ADVERSARIAL_REVIEWER_TIMEOUT_SAME_HEAD_LIMIT: '4' }), 4);
});


test('CASCADECAP-01 reaper records the original build even for terminal-at-cap timeout failures', () => fixture(root => {
  const db = new Database(':memory:');
  try {
    ensureReviewStateSchema(db);
    const startedAt = '2026-01-01T00:00:00Z';
    db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
      reviewer_session_uuid, reviewer_started_at, reviewer_head_sha, infra_auto_recover_attempts)
      VALUES (?, 1, '2026-01-01', 'gemini', 'open', 'reviewing', 'synthetic-session', ?, 'head-a', 3)`)
      .run(identity.repo, startedAt);
    db.prepare(`INSERT INTO reviewer_passes (repo, pr_number, attempt_number, reviewer_class,
      pass_kind, started_at, status, head_sha, metadata_json)
      VALUES (?, 1, 1, 'gemini', 'first-pass', ?, 'running', 'head-a', ?)`)
      .run(identity.repo, startedAt, JSON.stringify({ reviewerSessionUuid: 'synthetic-session', reviewerBuildId: 'build-old' }));
    const result = reapRunningPassTimeouts({ db, rootDir: root,
      now: () => new Date('2026-01-01T02:00:00Z'), isReviewerAlive: () => false,
      log: { log() {}, warn() {}, error() {} } });
    assert.equal(result.reviewClaimsFailed, 1);
    const state = readCascadeState(root, identity);
    assert.equal(state.reviewerTimeout.headSha, 'head-a');
    assert.equal(state.reviewerTimeout.reviewerBuildId, 'build-old');
    assert.equal(state.reviewerTimeout.count, 1);
  } finally { db.close(); }
}));


test('CASCADECAP-01 reviewer build identity supports partial installations and changes only for reviewer inputs', () => fixture(root => {
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'reviewer-fixture.mjs'), 'synthetic reviewer v1');
  const moduleUrl = pathToFileURL(join(root, 'src', 'reviewer-timeout-budget.mjs'));
  const partial = reviewerBuildDigest(moduleUrl);
  assert.equal(reviewerBuildDigest(moduleUrl), partial);
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'reviewer.first.md'), 'synthetic prompt v1');
  const complete = reviewerBuildDigest(moduleUrl);
  assert.notEqual(complete, partial);
  writeFileSync(join(root, 'prompts', 'remediator.first.md'), 'synthetic remediation prompt');
  assert.equal(reviewerBuildDigest(moduleUrl), complete, 'unrelated remediation changes do not re-arm reviewers');
  writeFileSync(join(root, 'prompts', 'reviewer.first.md'), 'synthetic prompt v2');
  assert.notEqual(reviewerBuildDigest(moduleUrl), complete);
}));
