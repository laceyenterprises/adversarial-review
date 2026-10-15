import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { markFollowUpJobCompleted, markFollowUpJobFailed, markFollowUpJobStopped } from '../src/follow-up-jobs.mjs';
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

// These are administrative transitions, rather than reconciled worker replies.
// Keep the exemption names and reasons in the PR's completion-path audit too.
const exemptions = {
  'no-remediation-started': 'Settled review or exhausted budget; no worker started for this job.',
  'interrupted-without-reconciled-reply': 'Lifecycle, stale claim, or pre-spawn stop interrupted reply reconciliation.',
  'worker-start-failed': 'Worker preparation or startup failed before reply reconciliation.',
  'round-requeue-refused': 'An additional round was refused; an existing delivery is retained.',
  'operator-stop': 'An explicit operator stop does not reconcile a worker reply; an existing delivery is retained.',
};

function terminalCallSites() {
  const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const calls = [];
  const writers = new Set(['markFollowUpJobCompleted', 'markFollowUpJobFailed', 'markFollowUpJobStopped', 'markStoppedImpl']);
  function visit(node, file) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && writers.has(node.callee.name)) {
      calls.push({ file: relative(sourceRoot, file), line: node.loc.start.line,
        writer: node.callee.name, properties: node.arguments[0]?.properties || [] });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, file));
      else if (value && typeof value === 'object') visit(value, file);
    }
  }
  for (const name of readdirSync(sourceRoot, { recursive: true })) {
    if (!name.endsWith('.mjs')) continue;
    const file = join(sourceRoot, name);
    const source = readFileSync(file, 'utf8');
    if (!/markFollowUpJob(?:Completed|Failed|Stopped)|markStoppedImpl/u.test(source)) continue;
    visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true }), file);
  }
  return calls;
}

test('REMCOMMENT-01: every terminal writer call records delivery or a documented exemption', async t => {
  const paths = terminalCallSites();
  assert.ok(paths.length > 30, 'inventory must include ordinary, recovery, admission, and stop paths');
  for (const row of paths) {
    await t.test(`${row.file}:${row.line} ${row.writer}`, child => {
      const deliveryProperty = row.properties.find(p => p.key?.name === 'commentDelivery');
      const exemption = row.properties.find(p => p.key?.name === 'commentDeliveryExemption')?.value?.value;
      assert.ok(deliveryProperty || exemptions[exemption], 'terminal call must supply delivery or name its exemption');
      const f = fixture(child);
      const commentDelivery = deliveryProperty ? buildReconcileCommentDelivery({
        job: f.job, worker: f.job.remediationWorker, action: 'completed', reply: f.payload,
      }).commentDelivery : null;
      const writer = row.writer === 'markFollowUpJobCompleted' ? markFollowUpJobCompleted
        : row.writer === 'markFollowUpJobFailed' ? markFollowUpJobFailed : markFollowUpJobStopped;
      const result = writer({ rootDir: f.rootDir, jobPath: f.jobPath, commentDelivery,
        commentDeliveryExemption: exemption, error: new Error('Synthetic worker failure.'),
        stopCode: 'synthetic-stop', stopReason: 'Synthetic administrative stop.' });
      const record = JSON.parse(readFileSync(result.jobPath, 'utf8'));
      if (deliveryProperty) assert.deepEqual(record.commentDelivery, commentDelivery);
      else assert.equal(record.commentDeliveryExemption, exemption);
    });
  }
});

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
