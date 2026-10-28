import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgyReviewerIdentityPool, setAgyReviewerIdentityPoolForTests } from '../src/agy-reviewer-identities.mjs';
import { acquireArgusGeminiLease } from '../src/argus-reviewer-identity.mjs';
import { startGeminiQuotaCooldown, readGeminiQuotaCooldown } from '../src/gemini-quota-cooldown.mjs';
import { createDefaultArgusReviewDeps } from '../src/argus-security-review-deps.mjs';
import { createArgusSecurityDrain, runArgusReviewChild, ARGUS_REVIEW_OUTCOME_PREFIX } from '../src/argus-security-drain.mjs';
import { readReviewerRunRecord, readRecoverableReviewerRunRecords } from '../src/adapters/reviewer-runtime/run-state.mjs';

import { retireArgusBacklog } from '../src/argus-backlog-retirement.mjs';
import { reviewArgusJob } from '../src/argus-security-review.mjs';
import { enqueueArgusSecurityReview, findArgusJob, claimNextArgusJob, failArgusJob } from '../src/argus-security-queue.mjs';
import { resolveArgusSecurityVerdict } from '../src/argus-security-verdict.mjs';

const quiet = { log() {}, info() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-10-10T10:00:00Z');
const RESET = new Date(NOW + 4 * 60 * 60 * 1000).toISOString();
const HEAD = 'a'.repeat(40);
const JOB = { repo: 'example/security', prNumber: 1, headSha: HEAD, jobId: 'synthetic-job', reasons: [] };
const TEXT = '<argus-review-json>{"verdict":"approve","summary":"fine","findings":[]}</argus-review-json>';

async function withPool(fn) {
  const rootDir = mkdtempSync(join(tmpdir(), 'argusquota-'));
  const cleanups = [];
  const poolOptions = {
    env: {}, log: quiet, now: () => NOW, hqOwner: 'owner-identity',
    loadIdentities: () => ['owner-identity', 'reviewer-b'], resolveRuntime: () => 'antigravity',
    runStateRootDir: rootDir, readBootstrapRecordImpl: () => null,
    referenceSettings: () => [], listUserProcessesImpl: async () => ({ ok: true, processes: [] }),
    leaseWaitMs: 0,
    runPinnedImpl: async ({ user, args }) => {
      if (args[0] === 'cleanup') cleanups.push({ user, reviewId: args[1] });
      return { code: 0, stdout: args[0] === 'status'
        ? 'keychain.exists=yes\nkeychain.item=readable\nsettings.valid=yes\n' : '', stderr: '' };
    },
    deliverAlertImpl: async () => { throw new Error('unexpected alert'); },
    isPgidAliveImpl: () => true,
  };
  const pool = createAgyReviewerIdentityPool(poolOptions);
  const cooldown = (identityUser) => startGeminiQuotaCooldown({
    rootDir, env: {}, nowMs: NOW, log: quiet, hqOwner: 'owner-identity', identityUser, signal: { resetAt: RESET },
  });
  cooldown('owner-identity');
  try { await fn({ rootDir, pool, cleanups, cooldown, createPool: () => createAgyReviewerIdentityPool(poolOptions) }); }
  finally { rmSync(rootDir, { recursive: true, force: true }); }
}

function productionDeps({ rootDir, pool, runner, ...options }) {
  return createDefaultArgusReviewDeps({
    rootDir, env: {}, logger: quiet, identityPool: pool, nowMs: () => NOW,
    resolveReviewerModels: async () => ['gemini'], reviewWithGeminiImpl: runner,
    evidenceIo: {}, ensureWorkerRegistryReadyImpl: async () => {}, ...options,
  });
}

for (const failure of [false, true]) {
  test(`Argus leases reviewer-b and cleans/releases on ${failure ? 'failure' : 'success'}`, () => withPool(async ({ rootDir, pool, cleanups }) => {
    let seen;
    const deps = productionDeps({ rootDir, pool, runner: async (_diff, _title, options) => {
      seen = options.agyIdentity;
      assert.equal(pool.snapshot().find((state) => state.user === 'reviewer-b').leased, true);
      if (failure) throw new Error('reviewer execution failed');
      return TEXT;
    } });
    assert.deepEqual(await deps.resolveReviewerModels({ job: JOB, pr: {} }), ['gemini']);
    const run = deps.runReviewerModel({ model: 'gemini', prompt: 'T', cwd: rootDir, diff: '' });
    if (failure) await assert.rejects(run, /reviewer execution failed/u);
    else assert.equal((await run).text, TEXT);
    assert.equal(seen.user, 'reviewer-b');
    assert.deepEqual(cleanups, [{ user: 'reviewer-b', reviewId: seen.reviewId }]);
    assert.equal(pool.snapshot().some((state) => state.leased), false);
  }));
}

test('Argus releases its acquired identity when injected registry readiness fails', () => withPool(async ({ rootDir, pool, cleanups }) => {
  const outage = Object.assign(new Error('synthetic registry outage'), {code: 'registry-unavailable'});
  const releases = [];
  const identityPool = {...pool, release: async (lease, options) => {
    releases.push(options);
    return pool.release(lease, options);
  }};
  const deps = productionDeps({ rootDir, pool: identityPool,
    ensureWorkerRegistryReadyImpl: async ({env}) => {
      assert.deepEqual(env, {});
      assert.equal(pool.snapshot().find(state => state.user === 'reviewer-b').leased, true);
      throw outage;
    },
    runner: async () => assert.fail('registry outage must prevent a model call'),
  });
  await assert.rejects(deps.runReviewerModel({model: 'gemini', prompt: 'fixture', cwd: rootDir}), error => error === outage);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].failed, false, 'registry infrastructure never invalidates OAuth readiness');
  assert.equal(cleanups.length, 1);
  assert.equal(cleanups[0].user, 'reviewer-b');
  assert.equal(pool.snapshot().some(state => state.leased), false);
}));

test('Argus rechecks identity cooldown after awaited registry readiness', () => withPool(async ({ rootDir, pool, cooldown }) => {
  const deps = productionDeps({ rootDir, pool,
    ensureWorkerRegistryReadyImpl: async () => { cooldown('reviewer-b'); },
    runner: async () => assert.fail('identity cooled during readiness must not run'),
  });
  await assert.rejects(deps.runReviewerModel({model: 'gemini', prompt: 'fixture', cwd: rootDir}), error => error.resetAt === RESET);
  assert.equal(pool.snapshot().some(state => state.leased), false);
}));

test('with no ready identity Gemini is removed without running its harness', () => withPool(async ({ rootDir, pool, cooldown }) => {
  cooldown('reviewer-b');
  const deps = productionDeps({ rootDir, pool, runner: async () => { assert.fail('Gemini must not run'); } });
  assert.deepEqual(await deps.resolveReviewerModels({ job: JOB, pr: {} }), []);
  assert.equal(deps.reviewerDeferral().resetAt, RESET);
}));

for (const failure of [false, true]) {
  test(`watcher holds the shared lease across the child and releases on ${failure ? 'spawn failure' : 'success'}`, () => withPool(async ({ rootDir, pool, cleanups }) => {
    let held;
    const run = runArgusReviewChild({
      rootDir, jobPath: join(rootDir, 'job.json'), identityPool: pool, env: {}, logger: quiet,
      geminiEnabled: () => true, nowMs: () => NOW,
      execFileImpl: (_cmd, args, options, callback) => {
        held = JSON.parse(args[args.indexOf('--agy-lease') + 1]);
        assert.equal(held.user, 'reviewer-b');
        assert.equal(pool.snapshot().find((state) => state.user === held.user).leased, true);
        assert.equal(options.detached, true);
        queueMicrotask(() => {
          const record = readReviewerRunRecord(rootDir, held.reviewId);
          assert.equal(record.pgid, 123);
          assert.equal(record.subjectContext.agyIdentityLease.user, 'reviewer-b');
          if (failure) callback(new Error('spawn failed'), '', '');
          else callback(null, `${ARGUS_REVIEW_OUTCOME_PREFIX}{"kind":"complete","result":{"verdict":"approve"}}\n`, '');
        });
        return { pid: 123 };
      },
    });
    if (failure) await assert.rejects(run, /spawn failed/u);
    else assert.equal((await run).kind, 'complete');
    assert.equal(pool.snapshot().some((state) => state.leased), false);
    assert.equal(cleanups.length, 1);
    assert.equal(readReviewerRunRecord(rootDir, held.reviewId).state, failure ? 'failed' : 'completed');
  }));
}

for (const { name, outcome, reason = '', failed = false } of [
  ...['claude', 'codex'].map((model) => ({
    name: `${model} failure without a Gemini attempt`,
    outcome: { kind: 'retry', error: `${model}: reviewer execution failed`, modelAttempts: [
      { model, failureClass: 'reviewer-execution-failed' },
    ] },
  })),
  { name: 'pre-review error', outcome: { kind: 'retry', error: 'live PR read failed' } },
  { name: 'empty attempts', outcome: { kind: 'retry', error: 'reviewer execution failed', modelAttempts: [] } },
  ...['quota-exhausted', 'agy-identity-unavailable', 'reviewer-execution-failed'].map((failureClass) => ({
    name: `Gemini ${failureClass} before a Codex failure`,
    outcome: { kind: 'retry', error: 'codex: reviewer execution failed', modelAttempts: [
      { model: 'gemini', failureClass }, { model: 'codex', failureClass: 'reviewer-execution-failed' },
    ] },
    reason: failureClass,
    failed: failureClass === 'reviewer-execution-failed',
  })),
  {
    name: 'Gemini failure before successful fallback',
    outcome: { kind: 'complete', result: { verdict: 'approve', reviewer: {
      model: 'codex', attempts: [{ model: 'gemini', failureClass: 'reviewer-execution-failed' }],
    } } },
    reason: 'reviewer-execution-failed', failed: true,
  },
]) {
  test(`shared Gemini lease settlement: ${name}`, () => withPool(async ({ rootDir, pool, cleanups }) => {
    let held;
    let released;
    const identityPool = {
      refreshReadiness: () => pool.refreshReadiness(), plan: () => pool.plan(), readyUsers: () => pool.readyUsers(),
      acquire: () => pool.acquire(),
      release: (lease, options) => { released = options; return pool.release(lease, options); },
    };
    const result = await runArgusReviewChild({
      rootDir, jobPath: join(rootDir, 'job.json'), identityPool, env: {}, logger: quiet,
      geminiEnabled: () => true, nowMs: () => NOW,
      execFileImpl: (_cmd, args, _options, callback) => {
        held = JSON.parse(args[args.indexOf('--agy-lease') + 1]);
        queueMicrotask(() => callback(null, `${ARGUS_REVIEW_OUTCOME_PREFIX}${JSON.stringify(outcome)}\n`, ''));
        return { pid: 123 };
      },
    });
    assert.deepEqual(result, outcome);
    assert.deepEqual(released, { failed, reason });
    const state = pool.snapshot().find((entry) => entry.user === held.user);
    assert.equal(state.leased, false);
    assert.equal(state.needsProbe, failed);
    assert.equal(state.ready, !failed);
    assert.equal(cleanups.length, 1);
    assert.equal(readReviewerRunRecord(rootDir, held.reviewId).state, failed ? 'failed' : 'completed');
  }));
}

for (const withOptions of [false, true]) {
  test(`Argus lease acquisition defaults the shared pool ${withOptions ? 'with options' : 'without arguments'}`, () => withPool(async ({ rootDir, pool }) => {
    setAgyReviewerIdentityPoolForTests(pool);
    let lease;
    try {
      ({ lease } = await (withOptions ? acquireArgusGeminiLease({ rootDir, env: {}, logger: quiet, nowMs: NOW })
        : acquireArgusGeminiLease()));
      assert.ok(lease);
      assert.equal(pool.snapshot().find((state) => state.user === lease.user).leased, true);
    } finally {
      if (lease) await pool.release(lease);
      setAgyReviewerIdentityPoolForTests(null);
    }
  }));
}

test('Gemini quota records the leased identity cooldown before release', () => withPool(async ({ rootDir, pool }) => {
  const deps = productionDeps({ rootDir, pool, runner: async () => {
    throw new Error(`Individual quota reached; resets at ${RESET}`);
  } });
  await assert.rejects(deps.runReviewerModel({ model: 'gemini', prompt: 'T', cwd: rootDir }), (err) => err.resetAt === RESET);
  const cooldown = readGeminiQuotaCooldown({ rootDir, env: {}, nowMs: NOW, hqOwner: 'owner-identity', identityUser: 'reviewer-b', log: quiet });
  assert.equal(cooldown.resetAt, RESET);
  assert.equal(pool.snapshot().find((state) => state.user === 'reviewer-b').needsProbe, false);
}));


function reviewDeps(models, runner) {
  return {
    fetchPullRequest: async () => ({ state: 'OPEN', headSha: HEAD, title: '[claude-code] synthetic change' }),
    fetchDiff: async () => 'synthetic diff',
    resolveReviewerModels: async () => models,
    runReviewerModel: runner,
    postComment: async () => { assert.fail('clean approval needs no comment'); },
  };
}

function review(deps, job = JOB, nowMs = NOW) {
  return reviewArgusJob({ job, deps, workDir: '.', nowMs, logger: quiet, promptTemplate: 'T' });
}

test('no ready identity defers until the pool reset without invoking Gemini', () => withPool(async ({ rootDir, pool, cooldown }) => {
  cooldown('reviewer-b');
  const production = productionDeps({ rootDir, pool, runner: async () => { assert.fail('Gemini must not run'); } });
  const deps = { ...reviewDeps([], null), resolveReviewerModels: production.resolveReviewerModels, reviewerDeferral: production.reviewerDeferral };
  const outcome = await review(deps);
  assert.equal(outcome.kind, 'defer');
  assert.equal(NOW + outcome.retryAfterMs, Date.parse(RESET));
}));

test('a quota-exhausted Gemini falls through to another reviewer in the same attempt', async () => {
  const calls = [];
  const outcome = await review(reviewDeps(['gemini', 'codex'], async ({ model }) => {
    calls.push(model);
    if (model === 'gemini') throw new Error('Individual quota reached');
    return { text: TEXT };
  }));
  assert.deepEqual(calls, ['gemini', 'codex']);
  assert.equal(outcome.kind, 'complete');
  assert.equal(outcome.result.reviewer.model, 'codex');
  assert.equal(outcome.result.reviewer.attempts[0].failureClass, 'quota-exhausted');
});

for (const error of [
  () => new Error(`Individual quota reached; resets at ${RESET}`),
  () => Object.assign(new Error('RESOURCE_EXHAUSTED'), { resetAt: RESET }),
  () => new Error('Individual quota reached'),
  () => new Error(`Command failed: ${'x'.repeat(700)} Individual quota reached; resets at ${RESET}`),
]) {
  test(`quota-only review defers without an attempt: ${error().message.slice(0, 50)}`, async () => {
    const outcome = await review(reviewDeps(['gemini'], async () => { throw error(); }));
    assert.equal(outcome.kind, 'defer');
    const known = error().message.includes('resets at') || error().resetAt;
    assert.equal(outcome.retryAfterMs, known ? Date.parse(RESET) - NOW : 15 * 60 * 1000);
    assert.equal(outcome.modelAttempts[0].failureClass, 'quota-exhausted');
  });
}

test('three quota-only drain passes never fail, and stay merge-blocking until reviewed', () => withPool(async ({ rootDir }) => {
  enqueueArgusSecurityReview({ rootDir, ...JOB, enqueuedAt: new Date(NOW).toISOString(), reasons: [{ trigger: 'sensitive-path' }] });
  let now = NOW;
  let runs = 0;
  const drain = createArgusSecurityDrain({
    rootDir, nowMs: () => now, logger: quiet,
    runJob: async ({ job }) => {
      runs += 1;
      const resetAt = new Date(now + 60 * 60 * 1000).toISOString();
      return review(reviewDeps(['gemini'], async () => { throw new Error(`Individual quota reached; resets at ${resetAt}`); }), job, now);
    },
  });
  for (let pass = 0; pass < 3; pass += 1) {
    drain.tick();
    await drain.drain();
    const found = findArgusJob(rootDir, JOB);
    assert.equal(found.bucket, 'pending');
    assert.equal(found.job.drain.attempts || 0, 0);
    assert.equal(found.job.drain.deferrals, pass + 1);
    assert.equal(Date.parse(found.job.drain.notBefore), now + 60 * 60 * 1000);
    assert.equal(resolveArgusSecurityVerdict({ rootDir, ...JOB, nowMs: now }).satisfiesGate, false);
    drain.tick();
    await drain.drain();
    assert.equal(runs, pass + 1, 'reset window prevents another execution');
    now += 60 * 60 * 1000;
  }
}));

test('a real model failure alongside quota exhaustion still spends attempts and reaches failed', () => withPool(async ({ rootDir }) => {
  enqueueArgusSecurityReview({ rootDir, ...JOB, enqueuedAt: new Date(NOW).toISOString(), reasons: [{ trigger: 'sensitive-path' }] });
  let now = NOW;
  const drain = createArgusSecurityDrain({
    rootDir, nowMs: () => now, logger: quiet,
    runJob: ({ job }) => review(reviewDeps(['gemini', 'codex'], async ({ model }) => {
      if (model === 'gemini') throw new Error('Individual quota reached');
      throw new Error('reviewer execution failed');
    }), job, now),
  });
  for (let pass = 1; pass <= 3; pass += 1) {
    drain.tick();
    await drain.drain();
    const found = findArgusJob(rootDir, JOB);
    assert.equal(found.job.drain.attempts, pass);
    assert.equal(found.job.drain.attemptHistory.length, pass);
    if (pass < 3) now = Date.parse(found.job.drain.notBefore);
    else assert.equal(found.bucket, 'failed');
  }
}));

function quotaError(models = ['gemini']) {
  return `no reviewer model produced a review: ${models.map((model) => `${model}: Gemini exec failed: Individual quota reached`).join(' | ')}`;
}

function failedJob(rootDir, prNumber, lastError, history = undefined) {
  enqueueArgusSecurityReview({ rootDir, ...JOB, prNumber, reasons: [{ trigger: 'sensitive-path' }], enqueuedAt: new Date(NOW).toISOString() });
  const claim = claimNextArgusJob({ rootDir, claimedAt: new Date(NOW).toISOString() });
  return failArgusJob({
    rootDir, ...claim, failedAt: new Date(NOW).toISOString(),
    job: { ...claim.job, drain: { attempts: 3, lastError, ...(history ? { attemptHistory: history } : {}) } },
    error: `argus review failed after 3 attempt(s): ${lastError}`,
  });
}

test('backlog requeues quota-only failures once at the authoritative open head, resetting attempts', () => withPool(async ({ rootDir }) => {
  failedJob(rootDir, 1, quotaError()); // Legacy: only the final diagnostic was recorded.
  const mixed = `${quotaError()} | codex: reviewer execution failed`;
  failedJob(rootDir, 2, mixed);
  failedJob(rootDir, 3, quotaError()); // Head moved.
  failedJob(rootDir, 4, quotaError()); // Closed or merged.
  const history = Array.from({ length: 3 }, (_, i) => ({ attempt: i + 1, error: quotaError() }));
  history[0].error = 'reviewer execution failed';
  failedJob(rootDir, 5, quotaError(), history); // Last attempt was quota, first was real.
  failedJob(rootDir, 6, quotaError(), Array.from({ length: 3 }, (_, i) => ({
    attempt: i + 1, error: quotaError(), modelAttempts: [{ model: 'gemini', error: 'Individual quota reached', failureClass: 'quota-exhausted' }],
  })));
  failedJob(rootDir, 7, quotaError(), [{ attempt: 3, error: quotaError() }]); // Incomplete new history.
  const lines = [];
  const options = {
    rootDir, nowMs: NOW, logger: { log: (line) => lines.push(line) },
    listOpenPullHeads: async (repo) => {
      assert.equal(repo, JOB.repo);
      return { complete: true, heads: new Map([[1, HEAD], [2, HEAD], [3, 'b'.repeat(40)], [5, HEAD], [6, HEAD], [7, HEAD]]) };
    },
  };
  const summary = await retireArgusBacklog(options);
  assert.equal(summary.requeuedQuotaFailures, 2);
  for (const prNumber of [1, 6]) {
    const found = findArgusJob(rootDir, { ...JOB, prNumber });
    assert.equal(found.bucket, 'pending');
    assert.equal(found.job.drain.attempts, 0);
    assert.deepEqual(found.job.drain.attemptHistory, []);
    assert.equal(found.job.error, null);
    assert.equal(found.job.failedAt, null);
    assert.equal(found.job.drain.notBefore, null);
    assert.equal(found.job.priorQuotaFailure.drain.attempts, 3);
    assert.equal(resolveArgusSecurityVerdict({ rootDir, ...JOB, prNumber, nowMs: NOW }).satisfiesGate, false);
  }
  for (const prNumber of [2, 3, 4, 5, 7]) {
    assert.equal(findArgusJob(rootDir, { ...JOB, prNumber }).bucket, 'failed');
  }
  const again = await retireArgusBacklog(options);
  assert.equal(again.requeuedQuotaFailures, 0);
  assert.equal(lines.filter((line) => line.startsWith('[argus-drain] requeued quota-only failure ')).length, 2);
}));

for (const listing of ['unreadable', 'truncated']) {
  test(`quota-failure recovery respects an ${listing} live listing`, () => withPool(async ({ rootDir }) => {
    failedJob(rootDir, 1, quotaError());
    await retireArgusBacklog({
      rootDir, nowMs: NOW, logger: quiet,
      listOpenPullHeads: async () => {
        if (listing === 'unreadable') throw new Error('listing unavailable');
        return { complete: false, heads: new Map([[1, HEAD]]) };
      },
    });
    assert.equal(findArgusJob(rootDir, JOB).bucket, 'failed');
  }));
}


test('a restarted watcher pool adopts the Argus child lease while ordinary runtime recovery ignores it', () => withPool(async ({ rootDir, pool, createPool }) => {
  let settle;
  let held;
  const child = runArgusReviewChild({
    rootDir, jobPath: join(rootDir, 'job.json'), identityPool: pool, env: {}, logger: quiet,
    geminiEnabled: () => true, nowMs: () => NOW,
    execFileImpl: (_cmd, args, _options, callback) => {
      held = JSON.parse(args[args.indexOf('--agy-lease') + 1]);
      settle = callback;
      return { pid: 123 };
    },
  });
  while (!settle) await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.deepEqual(readRecoverableReviewerRunRecords(rootDir), []);
    const restarted = createPool();
    assert.equal(await restarted.refreshReadiness(), 0);
    assert.equal(await restarted.acquire(), null);
    assert.deepEqual(restarted.snapshot().find((state) => state.user === 'reviewer-b').adoptedReviews, [held.reviewId]);
  } finally {
    settle(null, `${ARGUS_REVIEW_OUTCOME_PREFIX}{"kind":"complete","result":{"verdict":"approve"}}\n`, '');
    await child;
  }
}));

test('a lease cooled after routing is never used for a model call', () => withPool(async ({ rootDir, pool, cooldown }) => {
  await pool.refreshReadiness();
  const lease = await pool.acquire();
  const deps = productionDeps({ rootDir, pool, agyLease: lease, runner: async () => { assert.fail('cooled identity must not run'); } });
  cooldown('reviewer-b');
  try {
    await assert.rejects(deps.runReviewerModel({ model: 'gemini', prompt: 'T', cwd: rootDir }), (error) => error.resetAt === RESET);
  } finally { await pool.release(lease); }
}));

test('the drain uses an absolute known reset even when it is under a minute away', () => withPool(async ({ rootDir }) => {
  enqueueArgusSecurityReview({ rootDir, ...JOB, enqueuedAt: new Date(NOW).toISOString(), reasons: [{ trigger: 'sensitive-path' }] });
  const resetAt = new Date(NOW + 30_000).toISOString();
  const drain = createArgusSecurityDrain({
    rootDir, nowMs: () => NOW + 1000, logger: quiet,
    runJob: ({ job }) => review(reviewDeps(['gemini'], async () => { throw new Error(`Individual quota reached; resets at ${resetAt}`); }), job),
  });
  drain.tick();
  await drain.drain();
  assert.equal(findArgusJob(rootDir, JOB).job.drain.notBefore, resetAt);
}));
