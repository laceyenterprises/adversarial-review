import './helpers/dispatch-files-preload.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverHealthyReviewCli } from '../src/review-cli-recovery.mjs';
import { resolveReviewCliAsync } from '../src/review-cli-resolver.mjs';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { prepareReleaseReviewerClaim } from '../src/review-state-statements.mjs';
import { recordCascadeFailure, readCascadeState, CASCADE_FAILURE_CAP } from '../src/reviewer-cascade.mjs';

const quiet = { error() {}, warn() {} };
function fixture(t, attempts = 4) {
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

test('healthy re-probe re-queues at an exhausted cap without charging either budget', async t => {
  const f = fixture(t);
  assert.equal(await recoverHealthyReviewCli({ ...f, row: f.get(), log: quiet,
    resolveImpl: async cli => { assert.equal(cli, 'gemini'); return { status: 'resolved' }; },
  }), true);
  assert.equal(f.get().review_status, 'pending');
  assert.equal(f.get().infra_auto_recover_attempts, 4);
  assert.equal(f.get().review_attempts, 0);
  assert.equal(readCascadeState(f.rootDir, { repo: 'example/project', prNumber: 7 }).consecutiveTransientFailures, 0);
});

test('failed probe retains terminal evidence; stale healthy probe cannot replace a new claim', async t => {
  const f = fixture(t);
  const row = f.get();
  assert.equal(await recoverHealthyReviewCli({ ...f, row, log: quiet,
    resolveImpl: async () => { throw new Error('synthetic persistent failure'); },
  }), false);
  assert.deepEqual(f.get(), row);
  await recoverHealthyReviewCli({ ...f, row, log: quiet, resolveImpl: async () => {
    f.db.prepare("UPDATE reviewed_prs SET review_status = 'reviewing', reviewer_session_uuid = 'replacement'").run();
    return { status: 'resolved' };
  } });
  assert.equal(f.get().reviewer_session_uuid, 'replacement');
  assert.equal(f.get().review_status, 'reviewing');
});

for (const [healthy, attempts] of [[false, 0], [true, 4], [false, 4]]) {
  test(`settlement at threshold with resolver healthy=${healthy}, budget=${attempts}`, t => {
    const f = fixture(t, attempts);
    const failureAt = new Date().toISOString();
    for (let i = 1; i < CASCADE_FAILURE_CAP; i++) recordCascadeFailure(f.rootDir, {
      repo: 'example/project', prNumber: 7, failedAt: failureAt, failureClass: 'cli-resolution-transient',
    });
    f.db.prepare("UPDATE reviewed_prs SET review_status = 'reviewing', reviewer_session_uuid = 'current'").run();
    let probes = 0;
    settleReviewerAttempt({ rootDir: f.rootDir, repoPath: 'example/project', prNumber: 7,
      reviewerModel: 'gemini', reviewerHeadSha: 'synthetic-head', reviewerSessionUuid: 'current', failureAt,
      result: { ok: false, failureClass: 'cli-resolution-transient', error: 'synthetic timeout under load' }, log: quiet,
      resolverHealthyImpl: () => { probes++; return healthy; },
      statements: {
        getReviewRow: { get: f.get }, releaseReviewerClaim: prepareReleaseReviewerClaim(f.db),
        markPendingUpstream: f.db.prepare(`UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?,
          failure_message = ?, infra_auto_recover_attempts = infra_auto_recover_attempts + 1 WHERE repo = ? AND pr_number = ?`),
        markCascadeFailed: f.db.prepare(`UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?,
          failure_message = ? WHERE repo = ? AND pr_number = ?`),
      },
    });
    assert.equal(probes, 1);
    assert.equal(f.get().review_status, healthy ? 'pending' : attempts >= 3 ? 'failed' : 'pending-upstream');
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
