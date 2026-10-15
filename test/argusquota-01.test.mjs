import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgyReviewerIdentityPool } from '../src/agy-reviewer-identities.mjs';
import { startGeminiQuotaCooldown, readGeminiQuotaCooldown } from '../src/gemini-quota-cooldown.mjs';
import { createDefaultArgusReviewDeps } from '../src/argus-security-review-deps.mjs';
import { runArgusReviewChild, ARGUS_REVIEW_OUTCOME_PREFIX } from '../src/argus-security-drain.mjs';
import { readReviewerRunRecord } from '../src/adapters/reviewer-runtime/run-state.mjs';

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
