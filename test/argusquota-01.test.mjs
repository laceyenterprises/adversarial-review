import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgyReviewerIdentityPool } from '../src/agy-reviewer-identities.mjs';
import { startGeminiQuotaCooldown, readGeminiQuotaCooldown } from '../src/gemini-quota-cooldown.mjs';
import { createDefaultArgusReviewDeps } from '../src/argus-security-review-deps.mjs';
import { createArgusSecurityDrain, runArgusReviewChild, ARGUS_REVIEW_OUTCOME_PREFIX } from '../src/argus-security-drain.mjs';
import { readReviewerRunRecord } from '../src/adapters/reviewer-runtime/run-state.mjs';

import { reviewArgusJob } from '../src/argus-security-review.mjs';
import { enqueueArgusSecurityReview, findArgusJob } from '../src/argus-security-queue.mjs';
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
  const pool = createAgyReviewerIdentityPool({
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
  });
  const cooldown = (identityUser) => startGeminiQuotaCooldown({
    rootDir, env: {}, nowMs: NOW, log: quiet, hqOwner: 'owner-identity', identityUser, signal: { resetAt: RESET },
  });
  cooldown('owner-identity');
  try { await fn({ rootDir, pool, cleanups, cooldown }); }
  finally { rmSync(rootDir, { recursive: true, force: true }); }
}

function productionDeps({ rootDir, pool, runner, ...options }) {
  return createDefaultArgusReviewDeps({
    rootDir, env: {}, logger: quiet, identityPool: pool, nowMs: () => NOW,
    resolveReviewerModels: async () => ['gemini'], reviewWithGeminiImpl: runner,
    evidenceIo: {}, ...options,
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
