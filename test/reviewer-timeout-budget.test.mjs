import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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

for (const failureClass of ['cascade', 'provider-overloaded']) {
  test(`CASCADECAP-01 operator re-arm survives ${failureClass} and still permits only one timeout`, () => fixture(root => {
    timeout(root);
    const exhausted = timeout(root);
    const row = { rereview_reason: 'retrigger-review: operator probe', rereview_requested_at: '2026-01-02T00:00:00Z' };
    // A headless infrastructure write can occur before the scoped settlement.
    const unrelated = recordCascadeFailure(root, { ...identity, failureClass, failedAt: '2026-01-02T00:01:00Z' });
    assert.equal(reviewerTimeoutBudget(unrelated, { ...scope, row }).parked, false);
    const transient = recordCascadeFailure(root, { ...identity, ...scope, row, failureClass,
      failedAt: '2026-01-02T00:02:00Z' });
    assert.equal(transient.reviewerTimeout.rearmAt, row.rereview_requested_at);
    assert.equal(transient.reviewerTimeout.lastTimeoutAt, exhausted.reviewerTimeout.lastTimeoutAt);
    assert.equal(transient.reviewerTimeout.total, 2);
    assert.equal(transient.reviewerTimeout.count, 0);
    assert.equal(transient.reviewerTimeout.limit, 1);
    assert.equal(transient.nextRetryAfter, '2026-01-02T00:10:00.000Z', 'ordinary cascade backoff remains intact');
    const retry = reviewerTimeoutBudget(readCascadeState(root, identity), { ...scope, row });
    assert.equal(retry.parked, false);
    assert.equal(retry.changed, false, 're-arm is durably consumed once');
    const parked = timeout(root, { row, failedAt: '2026-01-02T00:11:00Z' });
    assert.equal(parked.reviewerTimeout.lastTimeoutAt, '2026-01-02T00:11:00.000Z');
    assert.equal(reviewerTimeoutBudget(parked, { ...scope, row }).parked, true);
    const laterTransient = recordCascadeFailure(root, { ...identity, ...scope, row, failureClass,
      failedAt: '2026-01-02T00:12:00Z' });
    assert.equal(reviewerTimeoutBudget(laterTransient, { ...scope, row }).parked, true);
    assert.equal(reviewerTimeoutBudget(laterTransient, { ...scope, row: {
      ...row, rereview_requested_at: '2026-01-02T00:13:00Z',
    } }).parked, false, 'a new operator request grants another probe');
  }));
}

test('CASCADECAP-01 legacy re-arm accepts missing timeout timestamps and rejects known stale requests', () => {
  const row = { reviewer_head_sha: scope.headSha, rereview_reason: 'retrigger-review: operator probe',
    rereview_requested_at: '2026-01-02T00:00:00Z' };
  for (const lastFailureAt of [undefined, null, 'invalid']) {
    const legacy = { transientFailureBreakdown: { 'reviewer-timeout': 2 }, lastFailureAt };
    assert.equal(reviewerTimeoutBudget(legacy, { ...scope, row }).parked, false);
  }
  const legacy = { transientFailureBreakdown: { 'reviewer-timeout': 2 },
    lastFailureClass: 'reviewer-timeout', lastFailureAt: '2026-01-02T00:01:00Z' };
  assert.equal(reviewerTimeoutBudget(legacy, { ...scope, row }).parked, true);
  assert.equal(reviewerTimeoutBudget({ ...legacy, lastFailureClass: 'cascade' }, { ...scope, row }).parked, false);
  assert.equal(reviewerTimeoutBudget(legacy, { ...scope, row: {
    ...row, rereview_requested_at: 'invalid',
  } }).parked, true);
});

test('CASCADECAP-01 changed build persists through non-timeout failures without renewing its probe', () => fixture(root => {
  timeout(root);
  timeout(root);
  const build = { ...scope, reviewerBuildId: 'build-b' };
  const transient = recordCascadeFailure(root, { ...identity, ...build, failureClass: 'cascade',
    failedAt: '2026-01-02T00:00:00Z' });
  assert.equal(transient.reviewerTimeout.reviewerBuildId, 'build-b');
  const retry = reviewerTimeoutBudget(readCascadeState(root, identity), build);
  assert.equal(retry.changed, false);
  assert.equal(retry.count, 0);
  assert.equal(retry.limit, 1);
  assert.equal(retry.total, 2);
  assert.equal(retry.parked, false);
  const parked = timeout(root, { ...build, failedAt: '2026-01-02T00:02:00Z' });
  assert.equal(reviewerTimeoutBudget(parked, build).parked, true);
  assert.equal(parked.reviewerTimeout.total, 3);
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

for (const relative of ['src/reviewer-fixture.mjs', 'src/adapters/reviewer-runtime/fixture.mjs', 'prompts/code-pr/reviewer.first.md']) {
  test(`CASCADECAP-01 build digest tolerates a file disappearing after enumeration: ${relative}`, t => fixture(root => {
    mkdirSync(join(root, 'src', 'adapters', 'reviewer-runtime'), { recursive: true });
    mkdirSync(join(root, 'prompts', 'code-pr'), { recursive: true });
    const file = join(root, relative);
    writeFileSync(file, 'synthetic reviewer input');
    const moduleUrl = pathToFileURL(join(root, 'src', 'reviewer-timeout-budget.mjs'));
    const present = reviewerBuildDigest(moduleUrl);
    const actualRead = fs.readFileSync;
    let errorCode = 'ENOENT';
    let vanishedReads = 0;
    t.mock.method(fs, 'readFileSync', (url, ...args) => {
      if (url instanceof URL && url.href === pathToFileURL(file).href) {
        vanishedReads++;
        throw Object.assign(new Error('synthetic file read failure'), { code: errorCode });
      }
      return actualRead(url, ...args);
    });
    syncBuiltinESMExports();
    try {
      const vanished = reviewerBuildDigest(moduleUrl);
      assert.notEqual(vanished, present, 'missing content changes the build identity');
      assert.equal(reviewerBuildDigest(moduleUrl), vanished, 'the missing-file marker is deterministic');
      assert.equal(vanishedReads, 2, 'the enumerated file was read on each traversal');
      errorCode = 'EACCES';
      assert.throws(() => reviewerBuildDigest(moduleUrl), { code: 'EACCES' }, 'other read failures remain visible');
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  }));
}
