import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { underMaxLoad } from './helpers/load-time-kit.mjs';
import { __test__ as harness } from '../src/reviewer-harness.mjs';
import { spawnCapturedProcessGroup } from '../src/process-group-spawn.mjs';
import { computeReviewerLeaseExpiryAt, extendReviewerLeaseForPlan, reviewerLeaseExpiryForRow } from '../src/reviewer-lease.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { resolveStreamedReviewerModelTimeoutMs, REVIEWER_PROCESS_SLACK_MS } from '../src/reviewer-timeout.mjs';
import { resolveReviewerAbsoluteCeilingMs } from '../src/reviewer-timeout-model.mjs';

for (const runtime of ['gemini', 'agy-plain', 'agy-identity-plain']) {
  test(`${runtime} allows diagnostic progress while stdout waits for the final answer`, async () => {
    const seen = [];
    const spawnWithInputImpl = async (_command, _args, options) => {
      seen.push(options);
      if (runtime.startsWith('agy') && seen.length === 1) {
        assert.equal(options.progressOnStdoutOnly, true);
        throw new Error('unknown option --output-format');
      }
      assert.equal(options.progressOnStdoutOnly, false);
      return spawnCapturedProcessGroup(process.execPath, ['-e',
        'const timer=setInterval(() => process.stderr.write("working\\n"),50); setTimeout(() => { clearInterval(timer); process.stdout.write("final answer"); },1500);',
      ], { progressOnStdoutOnly: options.progressOnStdoutOnly,
        firstOutputTimeout: 1000, progressTimeout: 1000, timeout: 5000 });
    };
    const common = { prompt: 'synthetic', model: 'synthetic', env: {}, timeout: 10_000, spawnWithInputImpl };
    const result = runtime === 'gemini'
      ? await harness.spawnGeminiReview({ ...common, geminiCli: process.execPath })
      : await harness.spawnAgyReview({ ...common, agyCli: process.execPath,
        ...(runtime.includes('identity') ? { identity: { user: 'synthetic', cwd: process.cwd(), workspaceDir: process.cwd() } } : {}) });
    // Identity captures are read back from files by the real wrapper; the fake
    // launcher above exercises the selected evidence rule through real pipes.
    if (!runtime.includes('identity')) assert.equal(result.stdout, 'final answer');
    assert.equal(seen.length, runtime === 'gemini' ? 1 : 2);
  });
}

test('streamed model budgets reserve posting time inside the absolute wrapper ceiling', t => {
  underMaxLoad(t);
  for (const seconds of [10800, 14400]) {
    const env = { AGENT_OS_REVIEWER_CEILING_MAX_SECONDS: String(seconds) };
    assert.equal(resolveStreamedReviewerModelTimeoutMs({ changedLines: Number.MAX_SAFE_INTEGER, env }),
      resolveReviewerAbsoluteCeilingMs(env) - REVIEWER_PROCESS_SLACK_MS);
  }
  assert.equal(resolveStreamedReviewerModelTimeoutMs({ changedLines: 0,
    env: { AGENT_OS_REVIEWER_CEILING_MAX_SECONDS: '1' } }), 1);
});

test('lease creation, extension and persisted/fallback reads share the scoped ceiling', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  ensureReviewStateSchema(db);
  const startedAt = '2026-01-01T00:00:00.000Z';
  const env = { AGENT_OS_REVIEWER_CEILING_MAX_SECONDS: '14400' };
  assert.equal(computeReviewerLeaseExpiryAt(startedAt, 20_000_000, { env }), '2026-01-01T04:00:00.000Z');
  db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, review_status,
    reviewer_session_uuid, reviewer_started_at, reviewer_timeout_ms)
    VALUES ('example/project', 1, ?, 'codex', 'reviewing', 'synthetic', ?, 1000)`).run(startedAt, startedAt);
  assert.equal(extendReviewerLeaseForPlan(db, { repo: 'example/project', prNumber: 1,
    sessionUuid: 'synthetic', timeoutMs: 20_000_000, env }), true);
  const row = db.prepare('SELECT * FROM reviewed_prs').get();
  assert.equal(row.reviewer_timeout_ms, 14_400_000);
  assert.equal(row.reviewer_lease_expires_at, '2026-01-01T04:00:00.000Z');
  for (const reviewer_lease_expires_at of [row.reviewer_lease_expires_at, null]) {
    assert.equal(reviewerLeaseExpiryForRow({ ...row, reviewer_lease_expires_at }, { env }), '2026-01-01T04:00:00.000Z');
    assert.equal(reviewerLeaseExpiryForRow({ ...row, reviewer_lease_expires_at }, {
      env: { AGENT_OS_REVIEWER_CEILING_MAX_SECONDS: '3600' },
    }), '2026-01-01T01:00:00.000Z');
  }
});
