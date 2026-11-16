import './helpers/dispatch-files-preload.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverHealthyReviewCli } from '../src/review-cli-recovery.mjs';
import { resolveReviewCliAsync } from '../src/review-cli-resolver.mjs';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { prepareReleaseReviewerClaim } from '../src/review-state-statements.mjs';
import { recordCascadeFailure, readCascadeState, CASCADE_FAILURE_CAP } from '../src/reviewer-cascade.mjs';

const quiet = { error() {}, warn() {} };
function fixture(t, attempts = 1) {
  const rootDir = mkdtempSync(join(tmpdir(), 'resolver-recovery-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  t.after(() => db.close());
  db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, review_status,
    reviewer_head_sha, failure_message, failed_at, review_attempts, infra_auto_recover_attempts)
    VALUES ('example/project', 7, '2026-01-01', 'gemini', 'failed', 'synthetic-head',
    '[cli-resolution-transient] synthetic resolver failure', '2026-01-01', 0, ?)`).run(attempts);
  const get = () => db.prepare('SELECT * FROM reviewed_prs').get();
  return { db, rootDir, get };
}

test('exit code one is distinct from a timeout diagnostic', async () => {
  for (const code of [1, 'ETIMEDOUT']) {
    await assert.rejects(resolveReviewCliAsync('gemini', { log: quiet,
      execFileImpl: async () => { throw Object.assign(new Error('synthetic failure'), { code }); },
    }), error => error.binaryResolution.reason === code);
  }
});

test('healthy re-probe preserves the streak and budgets', async t => {
  const f = fixture(t);
  const before = recordCascadeFailure(f.rootDir, { repo: 'example/project', prNumber: 7,
    failureClass: 'cli-resolution-transient', failureReason: 'original failure', reviewerModel: 'gemini' });
  assert.equal(await recoverHealthyReviewCli({ ...f, row: f.get(), log: quiet,
    resolveImpl: async cli => { assert.equal(cli, 'gemini'); return { status: 'resolved' }; },
  }), true);
  const after = readCascadeState(f.rootDir, { repo: 'example/project', prNumber: 7 });
  for (const key of ['transientFailureBreakdown', 'transientFailureBreakdownByModel', 'lastFailureClass', 'lastFailureReason', 'lastFailureAt']) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.equal(f.get().review_status, 'pending');
  assert.equal(f.get().infra_auto_recover_attempts, 1);
  assert.equal(f.get().review_attempts, 0);
  assert.equal(readCascadeState(f.rootDir, { repo: 'example/project', prNumber: 7 }).consecutiveTransientFailures, 1);
});

test('failed probe retains terminal evidence; stale healthy probe cannot replace a new claim', async t => {
  const f = fixture(t);
  const row = f.get();
  assert.equal(await recoverHealthyReviewCli({ ...f, row, log: quiet,
    resolveImpl: async () => { throw new Error('synthetic persistent failure'); },
  }), false);
  assert.deepEqual(f.get(), row);
  const hold = readCascadeState(f.rootDir, { repo: row.repo, prNumber: row.pr_number });
  assert.ok(Date.parse(hold.nextRetryAfter) > Date.now());
  assert.equal(hold.transientFailureBreakdown, undefined);
  await recoverHealthyReviewCli({ ...f, row, log: quiet, resolveImpl: async () => {
    f.db.prepare("UPDATE reviewed_prs SET review_status = 'reviewing', reviewer_session_uuid = 'replacement'").run();
    return { status: 'resolved' };
  } });
  assert.equal(f.get().reviewer_session_uuid, 'replacement');
  assert.equal(f.get().review_status, 'reviewing');
});

test('stale failed probe cannot delay a replacement claim', async t => {
  const f = fixture(t);
  const row = f.get();
  await recoverHealthyReviewCli({ ...f, row, log: quiet, resolveImpl: async () => {
    f.db.prepare("UPDATE reviewed_prs SET review_status = 'reviewing', reviewer_session_uuid = 'replacement'").run();
    throw new Error('synthetic late failure');
  } });
  assert.equal(readCascadeState(f.rootDir, { repo: row.repo, prNumber: row.pr_number }), null);
});

for (const attempts of [0, 4]) {
  test(`settlement at threshold does not probe synchronously, budget=${attempts}`, async t => {
    const f = fixture(t, attempts);
    const failureAt = new Date().toISOString();
    for (let i = 1; i < CASCADE_FAILURE_CAP; i++) recordCascadeFailure(f.rootDir, {
      repo: 'example/project', prNumber: 7, failedAt: failureAt, failureClass: 'cli-resolution-transient',
    });
    f.db.prepare("UPDATE reviewed_prs SET review_status = 'reviewing', reviewer_session_uuid = 'current'").run();
    const marker = join(f.rootDir, 'resolver-called');
    const hq = join(f.rootDir, 'hq');
    writeFileSync(hq, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    const previousHq = process.env.HQ_BIN;
    process.env.HQ_BIN = hq;
    t.after(() => { if (previousHq === undefined) delete process.env.HQ_BIN; else process.env.HQ_BIN = previousHq; });
    await settleReviewerAttempt({ rootDir: f.rootDir, repoPath: 'example/project', prNumber: 7,
      reviewerModel: 'gemini', reviewerHeadSha: 'synthetic-head', reviewerSessionUuid: 'current', failureAt,
      result: { ok: false, failureClass: 'cli-resolution-transient', error: 'synthetic timeout under load' }, log: quiet,
      statements: {
        getReviewRow: { get: f.get }, releaseReviewerClaim: prepareReleaseReviewerClaim(f.db),
        markPendingUpstream: f.db.prepare(`UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?,
          failure_message = ?, infra_auto_recover_attempts = infra_auto_recover_attempts + 1 WHERE repo = ? AND pr_number = ?`),
        markCascadeFailed: f.db.prepare(`UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?,
          failure_message = ? WHERE repo = ? AND pr_number = ?`),
      },
    });
    assert.equal(existsSync(marker), false);
    assert.equal(f.get().review_status, attempts >= 3 ? 'failed' : 'pending-upstream');
    assert.equal(f.get().infra_auto_recover_attempts, attempts || 1);
    assert.equal(f.get().review_attempts, 0);
  });
}

test('resolution backoff scales under synthetic load and old failures expire', t => {
  const f = fixture(t);
  const input = { repo: 'example/project', prNumber: 7, failureClass: 'cli-resolution-transient',
    loadAwareTimeoutMsImpl: ms => ms * 6 };
  const state = recordCascadeFailure(f.rootDir, { ...input, failedAt: '2026-01-01T00:00:00Z' });
  assert.equal(state.backoffMinutes, 6);
  assert.equal(state.nextRetryAfter, '2026-01-01T00:06:00.000Z');
  recordCascadeFailure(f.rootDir, { ...input, failedAt: '2026-01-01T00:06:00Z' });
  assert.equal(recordCascadeFailure(f.rootDir, { ...input, failedAt: '2026-01-01T02:00:00Z' }).consecutiveTransientFailures, 1);
});

test('one resolver observation is shared by all rows in a discovery pass', async t => {
  const f = fixture(t);
  const probeCache = new Map();
  let calls = 0;
  const resolveImpl = async () => { calls++; throw new Error('synthetic outage'); };
  for (let i = 0; i < 8; i++) await recoverHealthyReviewCli({ ...f, row: f.get(), probeCache, resolveImpl, log: quiet });
  assert.equal(calls, 1);
});

test('healthy recovery clears canonical claim fields and refuses closed PRs', async t => {
  const f = fixture(t);
  f.db.prepare("UPDATE reviewed_prs SET reviewer_started_at = '2026-01-01', reviewer_timeout_ms = 123, reviewer_session_uuid = 'old', reviewer_pgid = 99").run();
  await recoverHealthyReviewCli({ ...f, row: f.get(), resolveImpl: async () => ({ status: 'resolved' }) });
  for (const key of ['reviewer_head_sha', 'reviewer_started_at', 'reviewer_timeout_ms', 'reviewer_session_uuid', 'reviewer_pgid', 'reviewer_lease_expires_at']) assert.equal(f.get()[key], null, key);
  f.db.prepare("UPDATE reviewed_prs SET review_status = 'failed', pr_state = 'closed'").run();
  await recoverHealthyReviewCli({ ...f, row: f.get(), resolveImpl: async () => ({ status: 'resolved' }) });
  assert.equal(f.get().review_status, 'failed');
});

test('scheduled load backoff never expires the resolution streak', t => {
  const f = fixture(t);
  let failedAt = '2026-01-01T00:00:00Z';
  for (let i = 1; i <= CASCADE_FAILURE_CAP; i++) {
    const state = recordCascadeFailure(f.rootDir, { repo: 'example/project', prNumber: 7,
      failureClass: 'cli-resolution-transient', failedAt, loadAwareTimeoutMsImpl: ms => ms * 20 });
    assert.equal(state.consecutiveTransientFailures, i);
    failedAt = new Date(Date.parse(state.nextRetryAfter) + 60_000).toISOString();
  }
});

test('healthy watcher probes cannot refund repeated spawn failures', async t => {
  const f = fixture(t, 0);
  const failureAt = new Date().toISOString();
  for (let i = 1; i < CASCADE_FAILURE_CAP; i++) recordCascadeFailure(f.rootDir, {
    repo: 'example/project', prNumber: 7, failedAt: failureAt, failureClass: 'cli-resolution-transient',
  });
  const statements = {
    getReviewRow: { get: f.get }, releaseReviewerClaim: prepareReleaseReviewerClaim(f.db),
    markPendingUpstream: f.db.prepare(`UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?,
      failure_message = ?, infra_auto_recover_attempts = infra_auto_recover_attempts + 1 WHERE repo = ? AND pr_number = ?`),
    markCascadeFailed: f.db.prepare(`UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?,
      failure_message = ? WHERE repo = ? AND pr_number = ?`),
  };
  for (let attempt = 0; attempt <= 3; attempt++) {
    await recoverHealthyReviewCli({ ...f, row: f.get(), log: quiet,
      resolveImpl: async () => ({ status: 'resolved' }) });
    f.db.prepare("UPDATE reviewed_prs SET review_status = 'reviewing', reviewer_session_uuid = 'current', reviewer_head_sha = 'synthetic-head'").run();
    await settleReviewerAttempt({ rootDir: f.rootDir, repoPath: 'example/project', prNumber: 7,
      reviewerModel: 'gemini', reviewerHeadSha: 'synthetic-head', reviewerSessionUuid: 'current', failureAt,
      result: { ok: false, failureClass: 'cli-resolution-transient', error: 'persistent spawn-context failure' },
      statements, log: quiet });
    assert.equal(f.get().infra_auto_recover_attempts, Math.min(attempt + 1, 3));
    assert.equal(f.get().review_attempts, 0);
  }
  assert.equal(f.get().review_status, 'failed');
});
