import { createCliDirectReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/cli-direct/index.mjs';
import './helpers/dispatch-files-preload.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveReviewCli } from '../src/review-cli-resolver.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { runWithAgyReviewerIdentity } from '../src/agy-reviewer-identities.mjs';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { prepareReleaseReviewerClaim } from '../src/review-state-statements.mjs';
import { CASCADE_FAILURE_CAP, readCascadeState, readReviewerCredentialOutage, shouldBackoffReviewerSpawn } from '../src/reviewer-cascade.mjs';
import { infraRecoverableFailureClass } from '../src/reviewer-failure-classification.mjs';

const quiet = { error() {}, warn() {} };

test('resolver evidence beats auth text while genuine reviewer auth remains oauth-broken', () => {
  assert.equal(classifyReviewerFailure('review CLI resolution unavailable for gemini\nOAuth token invalid', 1), 'cli-resolution-transient');
  assert.equal(classifyReviewerFailure('OAuth token invalid', 1, null, { binaryResolution: { status: 'unknown' } }), 'cli-resolution-transient');
  assert.equal(classifyReviewerFailure('[review-cli-resolution] {"status":"unknown"}\nOAuth token invalid', 1), 'cli-resolution-transient');
  assert.equal(classifyReviewerFailure('OAuth token invalid', 1), 'oauth-broken');
  assert.equal(classifyReviewerFailure('[review-cli-resolution] {"status":"unknown"}\n[review-cli-resolution] {"status":"resolved"}\nOAuth token invalid', 1), 'oauth-broken');
  assert.equal(infraRecoverableFailureClass({ failure_message: '[cli-resolution-transient] resolver unavailable' }), 'cli-resolution-transient');
  assert.equal(infraRecoverableFailureClass({ failure_message: '[oauth-broken] review CLI resolution unavailable for gemini' }), 'cli-resolution-transient');
});

test('prefixed resolver observations retain latest-outcome classification', () => {
  const unknown = '[review-cli-resolution] {"status":"unknown"}';
  const resolved = '[review-cli-resolution] {"status":"resolved"}';
  for (const prefix of ['[worker-1] ', '2026-11-14T06:28:34Z ERROR ']) {
    assert.equal(classifyReviewerFailure(`${prefix}${unknown}`, 1), 'cli-resolution-transient');
    assert.equal(classifyReviewerFailure(`${prefix}${unknown}\r\n${prefix}${resolved}\r\nOAuth token invalid`, 1), 'oauth-broken');
    assert.equal(classifyReviewerFailure(`${prefix}${resolved}\n${prefix}${unknown}\nOAuth token invalid`, 1), 'cli-resolution-transient');
    assert.equal(classifyReviewerFailure(`${prefix}[review-cli-resolution] {broken\nOAuth token invalid`, 1), 'oauth-broken');
  }
});

test('invalid JSON releases the same seat, backs off, and only parks at the consecutive threshold', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewclijson-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  t.after(() => db.close());
  const repo = 'example/project', prNumber = 7;
  db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, review_status, review_attempts, infra_auto_recover_attempts)
    VALUES (?, ?, '2026-01-01', 'gemini', 'pending', 0, 0)`).run(repo, prNumber);
  const releases = [];
  const pool = {
    plan: () => ({ multi: true }),
    acquire: async () => ({ user: 'synthetic-seat', reviewId: 'synthetic-review' }),
    release: async (lease, outcome) => releases.push({ lease, outcome }),
  };
  const statements = {
    releaseReviewerClaim: prepareReleaseReviewerClaim(db),
    getReviewRow: db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?'),
    markPendingUpstream: db.prepare(`UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?, failure_message = ?,
      reviewer_session_uuid = NULL, infra_auto_recover_attempts = infra_auto_recover_attempts + 1 WHERE repo = ? AND pr_number = ?`),
  };
  for (let i = 1; i <= CASCADE_FAILURE_CAP; i += 1) {
    const session = `synthetic-${i}`;
    db.prepare("UPDATE reviewed_prs SET review_status = 'reviewing', reviewer_session_uuid = ?, reviewer_head_sha = 'synthetic-head' WHERE repo = ? AND pr_number = ?").run(session, repo, prNumber);
    const result = await runWithAgyReviewerIdentity({ reviewerModel: 'gemini', pool,
      adapter: { describe: () => ({ capabilities: { agyReviewerIdentity: true } }) }, log: quiet,
    }, async identity => {
      assert.equal(identity.user, 'synthetic-seat');
      try {
        resolveReviewCli('gemini', { execFileSyncImpl: () => '{synthetic malformed', log: quiet });
        assert.fail('malformed JSON must refuse resolution');
      } catch (err) {
        return { ok: false, failureClass: classifyReviewerFailure(err.message, 1, null, err), error: err.message };
      }
    });
    const failureAt = `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`;
    settleReviewerAttempt({ rootDir, repoPath: repo, prNumber, result,
      reviewerSessionUuid: session, reviewerHeadSha: 'synthetic-head', reviewerModel: 'gemini', failureAt, statements, log: quiet });
    const row = statements.getReviewRow.get(repo, prNumber);
    assert.equal(row.review_attempts, 0);
    assert.equal(row.infra_auto_recover_attempts, i < CASCADE_FAILURE_CAP ? 0 : 1);
    assert.equal(row.review_status, i < CASCADE_FAILURE_CAP ? 'pending' : 'pending-upstream');
    assert.equal(row.reviewer_session_uuid, null);
    assert.equal(releases.at(-1).outcome.failed, false, 'healthy seat remains available');
    assert.equal(readReviewerCredentialOutage(rootDir, 'gemini'), null);
    assert.equal(readCascadeState(rootDir, { repo, prNumber }).transientFailureBreakdown['cli-resolution-transient'], i);
    assert.equal(shouldBackoffReviewerSpawn(rootDir, { repo, prNumber, now: failureAt }).shouldBackoff, true);
  }
});

test('a thrown typed resolver error also releases a healthy identity', async () => {
  const releases = [];
  await assert.rejects(runWithAgyReviewerIdentity({ reviewerModel: 'gemini',
    adapter: { describe: () => ({ capabilities: { agyReviewerIdentity: true } }) },
    pool: {
      plan: () => ({ multi: true }),
      acquire: async () => ({ user: 'synthetic-seat', reviewId: 'synthetic-review' }),
      release: async (_lease, outcome) => releases.push(outcome),
    },
  }, async () => resolveReviewCli('gemini', { execFileSyncImpl: () => '{synthetic malformed', log: quiet })),
  { name: 'ReviewCliResolutionError' });
  assert.deepEqual(releases, [{ failed: false, reason: 'cli-resolution-transient' }]);
});

test('stale resolution results preserve a progressing replacement claim and its backoff', t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewclijson-stale-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const replacement = { review_status: 'reviewing', reviewer_head_sha: 'synthetic-head', reviewer_session_uuid: 'replacement' };
  const outcome = settleReviewerAttempt({ rootDir, repoPath: 'example/project', prNumber: 7,
    reviewerSessionUuid: 'predecessor', reviewerHeadSha: 'synthetic-head',
    result: { ok: false, failureClass: 'cli-resolution-transient' },
    statements: { getReviewRow: { get: () => replacement } }, log: quiet,
  });
  assert.equal(outcome.reason, 'cli-resolution-claim-mismatch');
  assert.equal(readCascadeState(rootDir, { repo: 'example/project', prNumber: 7 }), null);
});

test('cli-direct preflight retains resolution infrastructure evidence before spawning', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewclijson-runtime-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const adapter = createCliDirectReviewerRuntimeAdapter({ rootDir, logger: quiet,
    preflightImpl: async () => {
      throw Object.assign(new Error('synthetic path preflight'), {
        failureClass: 'oauth-broken', cause: { binaryResolution: { status: 'unknown' } },
      });
    },
    spawnCapturedImpl: async () => assert.fail('no reviewer may run without resolution'),
  });
  const result = await adapter.spawnReviewer({ model: 'gemini', prompt: 'synthetic',
    sessionUuid: 'synthetic-resolution-preflight', timeoutMs: 100,
    subjectContext: { domainId: 'code-pr', repo: 'example/project', prNumber: 7 },
    forbiddenFallbacks: ['api-key'],
  });
  assert.equal(result.failureClass, 'cli-resolution-transient');
});
