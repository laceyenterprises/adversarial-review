import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeWorkerPublishedHead } from '../src/remediation-published-head.mjs';
import {
  buildReconcileCommentDelivery,
  retryFailedCommentDeliveries,
  seedDeliveryRetryIndexFromHistory,
} from '../src/adapters/comms/github-pr-comments/comment-delivery.mjs';

// Keep routing independent of any host role configuration.
process.env.AGENT_OS_CONFIG_PATH = '/dev/null';

const completedAt = '2026-01-02T00:00:00.000Z';
const headSha = 'b'.repeat(40);
const log = { error() {}, warn() {} };

function fixture(t, { reply = true } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'remcomment-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const workspaceDir = join(rootDir, 'workspace');
  mkdirSync(join(workspaceDir, '.git'), { recursive: true });
  const replyPath = join(rootDir, 'reply.json');
  const job = {
    jobId: 'synthetic-remediation', repo: 'fixture/repo', prNumber: 1,
    status: 'in_progress', revisionRef: 'a'.repeat(40), workspaceDir,
    remediationWorker: { model: 'codex', state: 'spawned', replyPath, spawnedAt: '2026-01-01T00:00:00.000Z' },
    remediationPlan: { currentRound: 1, maxRounds: 3, rounds: [{
      round: 1, state: 'spawned', startHeadSha: 'a'.repeat(40), spawnedAt: '2026-01-01T00:00:00.000Z',
    }] },
  };
  const payload = {
    kind: 'adversarial-review-remediation-reply', schemaVersion: 1,
    jobId: job.jobId, repo: job.repo, prNumber: job.prNumber,
    outcome: 'completed', summary: 'Synthetic findings repaired and validated.',
    validation: ['Synthetic validation passed.'], addressed: [], pushback: [], blockers: [],
    reReview: { requested: true, reason: 'Synthetic remediation completed.' },
  };
  if (reply) writeFileSync(replyPath, JSON.stringify(payload));
  const jobPath = join(rootDir, 'data', 'follow-up-jobs', 'in-progress', `${job.jobId}.json`);
  mkdirSync(join(rootDir, 'data', 'follow-up-jobs', 'in-progress'), { recursive: true });
  writeFileSync(jobPath, JSON.stringify(job));
  return {
    rootDir, jobPath, job, payload,
    execFileSyncImpl: () => `${headSha}\nSynthetic remediation\n\nWorker-Job-Id: ${job.jobId}\n`,
    requestReviewRereviewImpl: () => ({ triggered: true, status: 'pending' }),
    requestRereviewWakeImpl: () => ({ requested: true }),
    requestWatcherWakeImpl: () => ({ requested: true }),
  };
}

for (const reply of [true, false]) {
  test(`REMCOMMENT-01: published-head completion owes the ordinary body (reply=${reply})`, async t => {
    const f = fixture(t, { reply });
    // An already-initialized index must still see newly completed recovery jobs.
    seedDeliveryRetryIndexFromHistory(f.rootDir, { maxAttempts: 5, log });
    const result = completeWorkerPublishedHead({ ...f, headSha, completedAt });
    assert.equal(result.job.status, 'completed');
    const delivery = result.job.commentDelivery;
    assert.equal(delivery.posted, false);
    assert.equal(delivery.attempts, 0);
    assert.equal(delivery.deliveryKind, 'remediation-reply');
    assert.equal(delivery.revisionRef, f.job.revisionRef);
    assert.equal(delivery.round, 1);
    const ordinary = buildReconcileCommentDelivery({
      job: result.job, worker: f.job.remediationWorker, action: 'completed',
      reply: reply ? f.payload : null, reReview: result.job.reReview, now: () => completedAt,
    });
    assert.equal(delivery.body, ordinary.commentDelivery.body);
    if (reply) assert.ok(delivery.body.includes(f.payload.summary));
    else assert.ok(!delivery.body.includes('## Summary'));
    let posts = 0;
    const sweep = () => retryFailedCommentDeliveries({
      rootDir: f.rootDir, log, postCommentImpl: async ({ body }) => {
        assert.equal(body, delivery.body);
        posts++;
        return { posted: true };
      },
    });
    assert.equal((await sweep()).posted, 1);
    assert.equal((await sweep()).retried, 0);
    assert.equal(posts, 1);
    assert.equal(JSON.parse(readFileSync(result.jobPath, 'utf8')).commentDelivery.posted, true);
  });
}
