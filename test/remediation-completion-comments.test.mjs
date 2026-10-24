import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { recoveryDigest, recoveryRecordPath, withCommentOnlyRecovery } from '../src/comment-only-recovery-record.mjs';
import { postRemediationOutcomeComment, extractRemediationCommentMarker } from '../src/adapters/comms/github-pr-comments/pr-comments.mjs';
import { archiveStoppedFollowUpJobs, markFollowUpJobCompleted, markFollowUpJobFailed, markFollowUpJobStopped } from '../src/follow-up-jobs.mjs';
import { completeWorkerPublishedHead, completeKnownWorkerPublish } from '../src/remediation-published-head.mjs';
import {
  buildReconcileCommentDelivery,
  deliveryLockPath,
  deliveryRetryIndexDir,
  deliveryRetryIndexPointerPath,
  historicalDeliverySidecarPath,
  REMEDIATION_REPLY_BACKFILL_SENTINEL,
  retryFailedCommentDeliveries,
  seedDeliveryRetryIndexFromHistory,
} from '../src/adapters/comms/github-pr-comments/comment-delivery.mjs';

const completedAt = '2026-01-02T00:00:00.000Z';
const headSha = 'b'.repeat(40);
const log = { error() {}, warn() {} };

function fixture(t, { reply = true } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'remcomment-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  // Keep routing independent of any host role configuration.
  process.env.AGENT_OS_CONFIG_PATH = join(rootDir, 'config.yaml');
  writeFileSync(process.env.AGENT_OS_CONFIG_PATH, '{}\n');
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
    ciGate: { headSha, state: 'green', conclusion: 'SUCCESS' },
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

function legacyTerminal(f, { status = 'completed', prState = 'open', workerState = 'completed' } = {}) {
  // Simulate a deployed queue whose original one-time seed is already done.
  seedDeliveryRetryIndexFromHistory(f.rootDir, { maxAttempts: 5, log });
  const dir = join(f.rootDir, 'data', 'follow-up-jobs', status);
  mkdirSync(dir, { recursive: true });
  const jobPath = join(dir, `${f.job.jobId}.json`);
  const job = { ...f.job, status, prState, completedAt,
    remediationWorker: { ...f.job.remediationWorker, state: workerState },
    remediationReply: { state: 'worker-wrote-reply', path: 'reply.json', payload: f.payload },
    reReview: { requested: true, triggered: true, status: 'pending' },
  };
  writeFileSync(jobPath, JSON.stringify(job));
  return { job, jobPath };
}

for (const prState of ['open', 'closed', 'merged']) {
  for (const markerExists of [false, true]) {
    test(`REMCOMMENT-01: backfill posts once under existing PR rules (${prState}, marker=${markerExists})`, async t => {
      const f = fixture(t);
      const old = legacyTerminal(f, { prState });
      const ordinary = buildReconcileCommentDelivery({ job: old.job, worker: old.job.remediationWorker,
        action: 'completed', reply: f.payload, reReview: old.job.reReview, now: () => completedAt });
      const marker = extractRemediationCommentMarker(ordinary.body);
      let creates = 0;
      let lookups = 0;
      const postCommentImpl = args => postRemediationOutcomeComment({ ...args,
        env: { GH_CODEX_REVIEWER_TOKEN: 'synthetic-token', AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY: '0' },
        findExistingImpl: async ({ marker: candidate }) => {
          lookups++;
          assert.equal(candidate, marker);
          return { found: markerExists, marker: candidate };
        },
        execFileImpl: async (command, args) => {
          assert.equal(command, 'gh');
          assert.deepEqual(args.slice(0, 2), ['pr', 'comment']);
          assert.equal(args[args.indexOf('--body') + 1], ordinary.body);
          creates++;
          return { stdout: '', stderr: '' };
        },
      });
      const sweep = () => retryFailedCommentDeliveries({ rootDir: f.rootDir, log, postCommentImpl });
      assert.equal((await sweep()).posted, 1);
      assert.equal((await sweep()).retried, 0);
      assert.equal(lookups, 1);
      assert.equal(creates, markerExists ? 0 : 1);
      const record = JSON.parse(readFileSync(old.jobPath, 'utf8'));
      assert.equal(record.commentDelivery.posted, true);
      assert.equal(record.commentDelivery.deliveryKind, 'remediation-reply');
      assert.equal(record.commentDelivery.round, 1);
      assert.equal(record.commentDelivery.revisionRef, f.job.revisionRef);
      assert.ok(record.commentDelivery.body.includes(f.payload.summary));
      assert.ok(existsSync(join(deliveryRetryIndexDir(f.rootDir), REMEDIATION_REPLY_BACKFILL_SENTINEL)));
    });
  }
}

for (const status of ['completed', 'stopped', 'failed']) {
  for (const topLevelWorker of [null, undefined]) {
    test(`REMCOMMENT-01: backfill preserves current-round worker attribution (${status}, top-level=${topLevelWorker})`, async t => {
      const f = fixture(t);
      const old = legacyTerminal(f, { status });
      const worker = { ...old.job.remediationWorker, model: 'claude-code',
        resolvedModel: 'synthetic-claude-model', resolvedReasoningLevel: 'high' };
      old.job.remediationWorker = topLevelWorker;
      old.job.builderTag = 'claude-code';
      old.job.remediationPlan = { ...old.job.remediationPlan, currentRound: 2,
        rounds: [{ round: 1, worker: f.job.remediationWorker }, { round: 2, worker }] };
      // Exercise the round worker's reply path as well as its execution fields.
      delete old.job.remediationReply;
      writeFileSync(old.jobPath, JSON.stringify(old.job));
      const ordinary = buildReconcileCommentDelivery({ job: old.job, worker,
        action: status, reply: f.payload, reReview: old.job.reReview });
      assert.equal(ordinary.workerClass, 'claude-code');
      assert.ok(ordinary.body.includes('synthetic-claude-model · high'));
      const result = await retryFailedCommentDeliveries({ rootDir: f.rootDir, log,
        postCommentImpl: async ({ body, workerClass }) => {
          assert.equal(workerClass, ordinary.workerClass);
          assert.equal(body, ordinary.body);
          return { posted: true };
        },
      });
      assert.equal(result.posted, 1);
      const record = JSON.parse(readFileSync(old.jobPath, 'utf8'));
      assert.equal(record.commentDelivery.workerClass, ordinary.workerClass);
      assert.equal(record.commentDelivery.body, ordinary.body);
    });
  }
}

test('REMCOMMENT-01: backfill validates the stored reply when its artifact was pruned', async t => {
  const f = fixture(t, { reply: false });
  const old = legacyTerminal(f);
  const ordinary = buildReconcileCommentDelivery({ job: old.job, worker: old.job.remediationWorker,
    action: 'completed', reply: f.payload, reReview: old.job.reReview });
  let posts = 0;
  const sweep = () => retryFailedCommentDeliveries({ rootDir: f.rootDir, log,
    postCommentImpl: async ({ body }) => {
      assert.equal(body, ordinary.body);
      posts++;
      return { posted: true };
    },
  });
  assert.equal((await sweep()).posted, 1);
  assert.equal((await sweep()).retried, 0);
  assert.equal(posts, 1);
  assert.equal(JSON.parse(readFileSync(old.jobPath, 'utf8')).commentDelivery.posted, true);
});

for (const source of ['previous-round', 'next-round', 'current-round', 'explicit-mismatch']) {
  test(`REMCOMMENT-01: pruned replies require current-round correspondence (${source})`, async t => {
    const f = fixture(t, { reply: false });
    const old = legacyTerminal(f);
    const currentReply = { ...f.payload, summary: 'Current round repair was validated.' };
    old.job.remediationWorker = null;
    old.job.remediationPlan = { currentRound: 2, rounds: [
      { round: 1, worker: old.job.remediationWorker, remediationReply: old.job.remediationReply },
      { round: 2, worker: { ...f.job.remediationWorker, state: 'completed' } },
      { round: 3, remediationReply: { payload: f.payload } },
    ] };
    if (source === 'current-round' || source === 'explicit-mismatch') {
      old.job.remediationPlan.rounds[1].remediationReply = { payload: source === 'current-round'
        ? currentReply : { ...currentReply, round: 1 } };
    }
    if (source === 'next-round') old.job.remediationReply.payload = { ...f.payload, round: 3 };
    writeFileSync(old.jobPath, JSON.stringify(old.job));
    let posts = 0;
    await retryFailedCommentDeliveries({ rootDir: f.rootDir, log,
      postCommentImpl: async ({ body }) => {
        assert.ok(body.includes(currentReply.summary));
        posts++;
        return { posted: true };
      },
    });
    assert.equal(posts, source === 'current-round' ? 1 : 0);
  });
}

test('REMCOMMENT-01: historical reply backfill resumes in bounded chunks without losing old archives', async t => {
  const f = fixture(t, { reply: false });
  const old = legacyTerminal(f);
  rmSync(old.jobPath);
  const records = [];
  for (let index = 0; index < 135; index++) {
    const jobId = `historical-${String(index).padStart(3, '0')}`;
    const directory = join(f.rootDir, 'data', 'follow-up-jobs', 'stopped-archived', index < 110 ? '2020-01' : '2021-02');
    mkdirSync(directory, { recursive: true });
    const jobPath = join(directory, `${jobId}.json`);
    writeFileSync(jobPath, JSON.stringify({ ...old.job, jobId, status: 'stopped',
      remediationReply: { ...old.job.remediationReply, payload: { ...f.payload, jobId } },
    }));
    records.push(jobPath);
  }
  let posts = 0;
  const sweep = () => retryFailedCommentDeliveries({ rootDir: f.rootDir, log, budget: 200,
    postCommentImpl: async () => { posts++; return { posted: true }; },
  });
  const sentinel = join(deliveryRetryIndexDir(f.rootDir), REMEDIATION_REPLY_BACKFILL_SENTINEL);
  await sweep();
  assert.ok(posts > 0 && posts <= 100, 'one tick must bound its historical record work');
  assert.equal(existsSync(sentinel), false, 'partial progress must not certify the migration');
  assert.equal(JSON.parse(readFileSync(records.at(-1), 'utf8')).commentDelivery, undefined);
  await sweep();
  assert.equal(posts, records.length, 'the durable cursor must continue into the next archive partition');
  assert.equal(existsSync(sentinel), true);
  await sweep();
  assert.equal(posts, records.length, 'completed migration must remain idempotent');
});

for (const invalid of ['missing', 'malformed', 'wrong-job', 'not-completed', 'exempt',
  'stored-wrong-job', 'stored-wrong-repo', 'stored-wrong-pr', 'stored-malformed', 'unreadable']) {
  test(`REMCOMMENT-01: backfill skips ineligible reply (${invalid})`, async t => {
    const f = fixture(t, { reply: invalid !== 'missing' });
    const old = legacyTerminal(f, { workerState: invalid === 'not-completed' ? 'spawned' : 'completed' });
    if (invalid === 'missing') delete old.job.remediationReply.payload;
    if (invalid.startsWith('stored-')) {
      rmSync(f.job.remediationWorker.replyPath);
      if (invalid === 'stored-wrong-job') old.job.remediationReply.payload.jobId = 'another-synthetic-job';
      if (invalid === 'stored-wrong-repo') old.job.remediationReply.payload.repo = 'fixture/other';
      if (invalid === 'stored-wrong-pr') old.job.remediationReply.payload.prNumber = 2;
      if (invalid === 'stored-malformed') old.job.remediationReply.payload = { summary: 'Incomplete reply.' };
    }
    if (invalid === 'malformed') writeFileSync(f.job.remediationWorker.replyPath, '{invalid');
    if (invalid === 'wrong-job') writeFileSync(f.job.remediationWorker.replyPath, JSON.stringify({ ...f.payload, jobId: 'another-synthetic-job' }));
    if (invalid === 'unreadable') {
      rmSync(f.job.remediationWorker.replyPath);
      mkdirSync(f.job.remediationWorker.replyPath);
    }
    if (invalid === 'exempt') old.job.commentDeliveryExemption = 'operator-stop';
    writeFileSync(old.jobPath, JSON.stringify(old.job));
    let posts = 0;
    const result = await retryFailedCommentDeliveries({ rootDir: f.rootDir, log,
      postCommentImpl: async () => { posts++; return { posted: true }; },
    });
    assert.equal(posts, 0);
    assert.equal(result.retried, 0);
    assert.equal(JSON.parse(readFileSync(old.jobPath, 'utf8')).commentDelivery, undefined);
  });
}

test('REMCOMMENT-01: a held delivery claim defers backfill without losing the migration', async t => {
  const f = fixture(t);
  const old = legacyTerminal(f);
  writeFileSync(deliveryLockPath(old.jobPath), JSON.stringify({ claimer: 'synthetic-other-sweep', claimedAt: new Date().toISOString() }));
  let posts = 0;
  const sweep = () => retryFailedCommentDeliveries({ rootDir: f.rootDir, log,
    postCommentImpl: async () => { posts++; return { posted: true }; },
  });
  assert.equal((await sweep()).retried, 0);
  assert.ok(!existsSync(join(deliveryRetryIndexDir(f.rootDir), REMEDIATION_REPLY_BACKFILL_SENTINEL)));
  rmSync(deliveryLockPath(old.jobPath));
  assert.equal((await sweep()).posted, 1);
  assert.equal((await sweep()).retried, 0);
  assert.equal(posts, 1);
});

test('REMCOMMENT-01: first retry initializes backfill on an empty follow-up queue', async t => {
  const f = fixture(t);
  rmSync(join(f.rootDir, 'data'), { recursive: true });
  const errors = [];
  const result = await retryFailedCommentDeliveries({ rootDir: f.rootDir,
    log: { error: message => errors.push(message) },
    postCommentImpl: async () => assert.fail('an empty queue has no comment to post'),
  });
  assert.deepEqual(errors, []);
  assert.equal(result.retried, 0);
  assert.ok(existsSync(join(deliveryRetryIndexDir(f.rootDir), REMEDIATION_REPLY_BACKFILL_SENTINEL)));
});

test('REMCOMMENT-01: recovery holds delivery ownership until the final re-review body is durable', async t => {
  const f = fixture(t);
  seedDeliveryRetryIndexFromHistory(f.rootDir, { maxAttempts: 5, log });
  let racingSweep;
  let posts = 0;
  const sweep = () => retryFailedCommentDeliveries({ rootDir: f.rootDir, log,
    postCommentImpl: async ({ body }) => {
      assert.match(body, /Re-review status:\*\* queued/);
      posts++;
      return { posted: true };
    },
  });
  const result = completeWorkerPublishedHead({ ...f, headSha, completedAt,
    requestReviewRereviewImpl: () => {
      const terminalPath = join(f.rootDir, 'data', 'follow-up-jobs', 'completed', `${f.job.jobId}.json`);
      assert.equal(JSON.parse(readFileSync(terminalPath, 'utf8')).commentDelivery.posted, false);
      assert.ok(existsSync(deliveryLockPath(terminalPath)));
      assert.ok(!existsSync(deliveryRetryIndexPointerPath(f.rootDir, terminalPath)),
        'a provisional re-review body must not be registered for retry');
      racingSweep = sweep();
      return { triggered: true, status: 'pending' };
    },
  });
  assert.equal((await racingSweep).scanned, 0);
  assert.equal(posts, 0);
  assert.ok(existsSync(deliveryRetryIndexPointerPath(f.rootDir, result.jobPath)));
  assert.ok(!existsSync(deliveryLockPath(result.jobPath)));
  assert.equal((await sweep()).posted, 1);
  assert.equal((await sweep()).retried, 0);
  assert.equal(posts, 1);
});

test('REMCOMMENT-01: an existing delivery claim defers published-head completion without mutations', async t => {
  const f = fixture(t);
  const terminalDir = join(f.rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(terminalDir, { recursive: true });
  const terminalPath = join(terminalDir, `${f.job.jobId}.json`);
  writeFileSync(deliveryLockPath(terminalPath), JSON.stringify({ claimer: 'synthetic-retained-claim', claimedAt: new Date().toISOString() }));
  const before = readFileSync(f.jobPath, 'utf8');
  let requests = 0;
  const recover = () => completeWorkerPublishedHead({ ...f, headSha, completedAt,
    requestReviewRereviewImpl: () => { requests++; return { triggered: true, status: 'pending' }; },
  });
  assert.equal(recover().reason, 'delivery-claim-held');
  assert.equal(completeKnownWorkerPublish({ ...f, proof: { headSha }, completedAt }).action, 'active');
  assert.equal(readFileSync(f.jobPath, 'utf8'), before);
  assert.equal(existsSync(terminalPath), false);
  assert.equal(requests, 0);
  assert.ok(existsSync(deliveryLockPath(terminalPath)), 'recovery must retain another claimant\'s lock');
  rmSync(deliveryLockPath(terminalPath));
  const result = recover();
  assert.equal(result.job.status, 'completed');
  assert.equal(result.job.reReview.triggered, true);
  assert.equal(result.job.commentDelivery.posted, false);
  assert.equal(requests, 1);
  assert.equal(existsSync(deliveryLockPath(terminalPath)), false);
});

for (const status of ['stopped', 'failed']) {
  test(`REMCOMMENT-01: backfill includes terminal ${status} records with completed workers`, async t => {
    const f = fixture(t);
    const old = legacyTerminal(f, { status });
    let posts = 0;
    const result = await retryFailedCommentDeliveries({ rootDir: f.rootDir, log,
      postCommentImpl: async ({ body }) => {
        assert.ok(body.includes(f.payload.summary));
        assert.equal(extractRemediationCommentMarker(body), extractRemediationCommentMarker(
          buildReconcileCommentDelivery({ job: old.job, worker: old.job.remediationWorker,
            action: status, reply: f.payload, reReview: old.job.reReview }).body));
        posts++;
        return { posted: true };
      },
    });
    assert.equal(result.posted, 1);
    assert.equal(posts, 1);
  });
}

test('REMCOMMENT-01: backfill scans history once and retains the existing attempt cap', async t => {
  const f = fixture(t);
  const old = legacyTerminal(f);
  let attempts = 0;
  const sweep = () => retryFailedCommentDeliveries({ rootDir: f.rootDir, log, maxAttempts: 2, budget: 1,
    postCommentImpl: async () => { attempts++; return { posted: false, reason: 'gh-cli-failure' }; },
  });
  assert.equal((await sweep()).failed, 1);
  assert.equal((await sweep()).failed, 1);
  assert.equal((await sweep()).retried, 0);
  assert.equal(attempts, 2);
  assert.equal(JSON.parse(readFileSync(old.jobPath, 'utf8')).commentDelivery.attempts, 2);

  const jobId = 'later-synthetic-remediation';
  writeFileSync(join(f.rootDir, 'later-reply.json'), JSON.stringify({ ...f.payload, jobId }));
  const laterPath = join(f.rootDir, 'data', 'follow-up-jobs', 'completed', `${jobId}.json`);
  writeFileSync(laterPath, JSON.stringify({ ...old.job, jobId,
    remediationReply: { state: 'worker-wrote-reply', path: 'later-reply.json' },
  }));
  assert.equal((await sweep()).retried, 0, 'the one-time migration must not scan history again');
  assert.equal(JSON.parse(readFileSync(laterPath, 'utf8')).commentDelivery, undefined);
});

for (const archivedBeforeBackfill of [true, false]) {
  test(`REMCOMMENT-01: archived stopped records retain their owed reply (archived before backfill=${archivedBeforeBackfill})`, async t => {
    const f = fixture(t);
    const old = legacyTerminal(f, { status: 'stopped' });
    writeFileSync(old.jobPath, JSON.stringify({ ...old.job, stoppedAt: completedAt }));
    const archive = () => archiveStoppedFollowUpJobs({ rootDir: f.rootDir,
      nowMs: Date.parse('2026-01-04T00:00:00.000Z'),
    });
    let attempts = 0;
    const sweep = () => retryFailedCommentDeliveries({ rootDir: f.rootDir, log,
      postCommentImpl: async ({ body }) => {
        assert.ok(body.includes(f.payload.summary));
        attempts++;
        return archivedBeforeBackfill || attempts > 1
          ? { posted: true } : { posted: false, reason: 'gh-cli-failure' };
      },
    });
    let archived;
    if (archivedBeforeBackfill) archived = archive();
    else {
      assert.equal((await sweep()).failed, 1);
      archived = archive();
    }
    assert.equal(archived.archived, 1);
    assert.equal((await sweep()).posted, 1);
    assert.equal((await sweep()).retried, 0);
    assert.equal(JSON.parse(readFileSync(archived.archivedPaths[0], 'utf8')).commentDelivery.posted, true);
    assert.equal(attempts, archivedBeforeBackfill ? 1 : 2);
  });
}

test('REMCOMMENT-01: archive resolution rewrites one pointer and retries once per tick after failures', async t => {
  const f = fixture(t);
  const old = legacyTerminal(f, { status: 'stopped' });
  writeFileSync(old.jobPath, JSON.stringify({ ...old.job, stoppedAt: completedAt }));
  let attempts = 0;
  const sweep = budget => retryFailedCommentDeliveries({ rootDir: f.rootDir, log, budget,
    postCommentImpl: async () => {
      attempts++;
      return { posted: false, reason: 'gh-cli-failure' };
    },
  });
  assert.equal((await sweep(5)).failed, 1);
  const archived = archiveStoppedFollowUpJobs({ rootDir: f.rootDir,
    nowMs: Date.parse('2026-01-04T00:00:00.000Z') });
  assert.equal(archived.archived, 1);
  const archivedPath = archived.archivedPaths[0];
  const pointerPath = deliveryRetryIndexPointerPath(f.rootDir, old.jobPath);
  assert.equal(pointerPath, deliveryRetryIndexPointerPath(f.rootDir, archivedPath));
  assert.equal((await sweep(0)).scanned, 1, 'resolution must survive a deferred retry');
  assert.deepEqual(JSON.parse(readFileSync(pointerPath, 'utf8')), { jobPath: archivedPath });
  for (const expectedAttempts of [2, 3]) {
    const result = await sweep(5);
    assert.equal(result.scanned, 1);
    assert.equal(result.failed, 1);
    assert.equal(attempts, expectedAttempts);
    assert.equal(JSON.parse(readFileSync(archivedPath, 'utf8')).commentDelivery.attempts, expectedAttempts);
    assert.deepEqual(readdirSync(deliveryRetryIndexDir(f.rootDir)).filter(name => name.endsWith('.json')),
      [`${f.job.jobId}.json`]);
  }
});

test('REMCOMMENT-01: comment backfill and archival preserve digest-pinned final-round recovery authority', async t => {
  const f = fixture(t);
  const old = legacyTerminal(f, { status: 'stopped' });
  const job = { ...old.job, stoppedAt: completedAt, finalRound: 'comment-only', completion: { withheldPushHeadSha: headSha } };
  writeFileSync(old.jobPath, JSON.stringify(job));
  const sourceBytes = readFileSync(old.jobPath, 'utf8');
  const recoveryPath = recoveryRecordPath(f.rootDir, job.jobId, 1);
  mkdirSync(dirname(recoveryPath), { recursive: true });
  writeFileSync(recoveryPath, JSON.stringify({ schemaVersion: 1, jobId: job.jobId,
    repo: job.repo, prNumber: job.prNumber, sourceDigest: recoveryDigest(job),
    reviewedHead: job.revisionRef, head: headSha, completed: true,
    completion: { workerPushedHeadSha: headSha,
      workerPushProof: { method: 'git-cherry-replay', generatedIndexPolicy: 'agent-os-main-index-v1' },
      finalRoundOutcome: { completed: true } },
  }));
  assert.ok(withCommentOnlyRecovery(f.rootDir, job).finalRoundRecovery);
  let posts = 0;
  const sweep = () => retryFailedCommentDeliveries({ rootDir: f.rootDir, log,
    postCommentImpl: async ({ body }) => {
      assert.ok(body.includes(f.payload.summary));
      posts++;
      return posts > 1 ? { posted: true } : { posted: false, reason: 'gh-cli-failure' };
    },
  });
  assert.equal((await sweep()).failed, 1);
  assert.equal(readFileSync(old.jobPath, 'utf8'), sourceBytes);
  const archived = archiveStoppedFollowUpJobs({ rootDir: f.rootDir,
    nowMs: Date.parse('2026-01-04T00:00:00.000Z'),
  });
  assert.equal(archived.archived, 1);
  const archivedPath = archived.archivedPaths[0];
  assert.equal((await sweep()).posted, 1);
  assert.equal((await sweep()).retried, 0);
  assert.equal(posts, 2);
  assert.equal(readFileSync(archivedPath, 'utf8'), sourceBytes, 'historical terminal bytes are authority evidence');
  assert.ok(withCommentOnlyRecovery(f.rootDir, JSON.parse(sourceBytes)).finalRoundRecovery);
  const delivery = JSON.parse(readFileSync(historicalDeliverySidecarPath(archivedPath), 'utf8'));
  assert.equal(delivery.posted, true);
  assert.equal(delivery.attempts, 2);
});
