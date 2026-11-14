import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { underMaxLoad } from './helpers/load-time-kit.mjs';
import { resolveReviewerAbsoluteCeilingMs, resolveReviewerCeilingSeconds } from '../src/reviewer-timeout-model.mjs';
import { resolveReviewerTimeoutMs, resolveProgressTimeoutMs, resolveGeminiReviewerProcessTimeoutMs } from '../src/reviewer-timeout.mjs';
import { reviewerStallOptions, isReviewerStall } from '../src/reviewer-stall.mjs';
import { __test__ as harness } from '../src/reviewer-harness.mjs';
import { computeReviewerLeaseExpiryAt, reviewerLeaseExpiryForRow } from '../src/reviewer-lease.mjs';
import { shouldReconcileStaleReviewerSession } from '../src/reviewer-orphan-reconcile.mjs';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { prepareReleaseReviewerClaim } from '../src/review-state-statements.mjs';
import { readCascadeState } from '../src/reviewer-cascade.mjs';
import { toAgentRequest } from '../src/adapters/reviewer-runtime/agent-runtime/index.mjs';
import { createCliDirectReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/cli-direct/index.mjs';

const hour = 3600_000;

test('all timeout families clamp oversized nominals after scaling using the existing CFG key', t => {
  underMaxLoad(t);
  const env = { AGENT_OS_REVIEWER_CEILING_MAX_SECONDS: '14400',
    ADVERSARIAL_REVIEWER_TIMEOUT_MS: String(20 * hour) };
  const ceiling = resolveReviewerAbsoluteCeilingMs(env);
  assert.equal(ceiling, 4 * hour);
  assert.equal(resolveReviewerCeilingSeconds({ changedLines: Number.MAX_SAFE_INTEGER, env }), ceiling / 1000);
  assert.equal(resolveReviewerTimeoutMs(env), ceiling);
  assert.ok(resolveGeminiReviewerProcessTimeoutMs(env) <= ceiling);
  assert.equal(resolveProgressTimeoutMs(env), 900_000);
  const stall = reviewerStallOptions(20 * hour, { model: 'synthetic' }, { env });
  assert.equal(stall.progressTimeout, 900_000);
  assert.ok(stall.firstOutputTimeout <= 900_000);
});

test('persisted historical 14-hour claim reaches existing reconcile selection at the absolute ceiling', () => {
  const row = { reviewer_started_at: '2026-01-01T00:00:00Z', reviewer_timeout_ms: 14 * hour,
    reviewer_lease_expires_at: '2026-01-01T14:00:00Z', reviewer_pgid: 99999 };
  assert.equal(computeReviewerLeaseExpiryAt(row.reviewer_started_at, 14 * hour), '2026-01-01T03:00:00.000Z');
  assert.equal(reviewerLeaseExpiryForRow(row), '2026-01-01T03:00:00.000Z');
  const policy = { leaseRecoveryEnabled: true, probeGroupAliveImpl: () => true };
  assert.equal(shouldReconcileStaleReviewerSession(row, new Date('2026-01-01T02:59:59Z'), policy), false);
  assert.equal(shouldReconcileStaleReviewerSession(row, new Date('2026-01-01T03:00:00Z'), policy), true);
});

test('native runtime request cannot bypass the process ceiling', () => {
  const request = toAgentRequest({ model: 'codex', timeoutMs: 14 * hour,
    subjectContext: { repo: 'example/project', prNumber: 1, reviewerHeadSha: 'synthetic', reviewAttemptNumber: 1, reviewDbAttemptNumber: 1, completedRemediationRounds: 0, maxRemediationRounds: 3 } }, { kind: 'reviewer' });
  assert.equal(request.timeoutMs, resolveReviewerAbsoluteCeilingMs());
  assert.equal(request.budget.maxWallMs, request.timeoutMs);
});

test('CLI wrapper cannot override the ceiling with a larger explicit request', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'leasecap-cli-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const observed = [];
  const adapter = createCliDirectReviewerRuntimeAdapter({ rootDir, preflightImpl: null,
    spawnCapturedImpl: async (_command, _args, options) => {
      observed.push(options.timeout);
      return { stdout: '', stderr: '' };
    } });
  for (const model of ['claude', 'codex', 'gemini']) {
    await adapter.spawnReviewer({ model, timeoutMs: 14 * hour, sessionUuid: `synthetic-${model}`,
      subjectContext: { repo: 'example/project', prNumber: 1 } });
  }
  assert.deepEqual(observed, Array(3).fill(resolveReviewerAbsoluteCeilingMs()));
});

for (const fileBacked of [false, true]) for (const replacement of [false, true]) test(`no-progress evidence releases only its claim (replacement=${replacement}, file=${fileBacked})`, async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'leasecap-stall-'));
  const db = new Database(':memory:');
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  ensureReviewStateSchema(db);
  const session = replacement ? 'replacement' : 'synthetic-session';
  db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, review_status,
    reviewer_session_uuid, review_attempts, infra_auto_recover_attempts)
    VALUES ('example/project', 1, '2026-01-01', 'codex', 'reviewing', ?, 1, 0)`).run(session);
  const receipts = [];
  let error;
  // A real model event arrives, then the synthetic model stops producing evidence.
  // Diagnostic stderr continues; it must not extend the model-progress window.
  try {
    await harness.spawnWithInput(process.execPath, ['-e',
      'console.log("model-event"); setInterval(() => console.error("diagnostic"), 10);'], {
      timeout: 10_000, firstOutputTimeout: 3000, progressTimeout: 500, killGraceMs: 20,
      ...(fileBacked ? { stdoutPath: join(rootDir, 'stdout'), stderrPath: join(rootDir, 'stderr') } : {}),
      progressOnStdoutOnly: true, stallReviewer: { model: 'synthetic' },
      onStdoutData: text => text.includes('model-event'), onStall: receipt => receipts.push(receipt),
    });
    assert.fail('silent model must be reclaimed');
  } catch (caught) { error = caught; }
  assert.ok(isReviewerStall(error));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].reason, 'no-progress');
  assert.ok(Date.parse(receipts[0].stalledAt) - Date.parse(receipts[0].lastProgressAt) < 3000);
  settleReviewerAttempt({ rootDir, repoPath: 'example/project', prNumber: 1,
    reviewerSessionUuid: 'synthetic-session', reviewerModel: 'codex',
    result: { ok: false, failureClass: 'reviewer-stalled', error: error.message },
    statements: { releaseReviewerClaim: prepareReleaseReviewerClaim(db) }, log: { warn() {} } });
  const row = db.prepare('SELECT * FROM reviewed_prs').get();
  assert.equal(row.review_status, replacement ? 'reviewing' : 'pending');
  assert.equal(row.review_attempts, 1);
  assert.equal(row.infra_auto_recover_attempts, 0);
});

test('recorded budget deferral follows its typed reset hold rather than stall recovery', t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'leasecap-budget-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let released = 0;
  const resetAt = '2026-01-01T01:00:00.000Z';
  const result = settleReviewerAttempt({ rootDir, repoPath: 'example/project', prNumber: 1,
    reviewerSessionUuid: 'synthetic-session', reviewerModel: 'codex', failureAt: '2026-01-01T00:00:00Z',
    result: { ok: false, failureClass: 'github-budget-deferred',
      stderr: '[reviewer-github-budget-deferred] ' + JSON.stringify({ resource: 'core', resetAt,
        remaining: 0, credential: 'synthetic' }) },
    statements: { releaseReviewerClaim: { run() { released++; } } } });
  assert.equal(result.reason, 'github-budget-deferred');
  assert.equal(released, 1);
  const state = readCascadeState(rootDir, { repo: 'example/project', prNumber: 1 });
  assert.equal(state.nextRetryAfter, resetAt);
  assert.equal(state.lastFailureClass, 'github-budget-deferred');
});
