import test from 'node:test';
import assert from 'node:assert/strict';
import { readAdmissionChecks, withAdmissionReadCache } from '../src/watcher-admission-read-cache.mjs';

const args = ['pr', 'view', '1', '--repo', 'example/review-fixture', '--json', 'headRefOid,statusCheckRollup'];
const executor = () => {};

test('WATCHERLAG-01: one drain shares identical concurrent check reads, the next drain refreshes', async () => {
  let calls = 0;
  const run = async () => ({ value: ++calls });
  const read = () => readAdmissionChecks(executor, 'gh', args, {}, run);
  await withAdmissionReadCache(async () => {
    const [first, second] = await Promise.all([read(), read()]);
    assert.equal(first, second); assert.equal(calls, 1);
  });
  await withAdmissionReadCache(read); assert.equal(calls, 2);
  await read(); assert.equal(calls, 3);
});

test('WATCHERLAG-01: credential/executor changes, expiry and failures never reuse check evidence', async () => {
  let calls = 0, now = 0;
  const run = async () => ++calls;
  const read = (exec = executor, env = {}) => readAdmissionChecks(exec, 'gh', args, { env }, run, { now: () => now });
  await withAdmissionReadCache(async () => {
    await read(); await read(); assert.equal(calls, 1);
    now = 10_000; await read(); assert.equal(calls, 2);
    await read(executor, { GH_TOKEN: 'synthetic-token' }); assert.equal(calls, 3);
    await read(() => {}); assert.equal(calls, 4);
    const failure = () => readAdmissionChecks(executor, 'gh', args, { env: { GH_HOST: 'example.invalid' } }, async () => { calls++; throw new Error('synthetic failure'); });
    await assert.rejects(failure()); await assert.rejects(failure()); assert.equal(calls, 6);
  });
});

test('WATCHERLAG-01: spawn-boundary freshness, labels, dedup and mutations always read live', async () => {
  let calls = 0;
  await withAdmissionReadCache(async () => {
    for (const request of [
      ['pr', 'view', '1', '--json', 'headRefOid,state,isDraft,labels'],
      ['api', 'repos/example/review-fixture/pulls/1/reviews'],
      ['pr', 'edit', '1', '--add-label', 'synthetic-label'],
    ]) {
      for (let repeat = 0; repeat < 2; repeat++) await readAdmissionChecks(executor, 'gh', request, {}, async () => ++calls);
    }
  });
  assert.equal(calls, 6);
});

test('WATCHERLAG-01: the production drain and metered executor share check reads without sharing freshness', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { createReviewerDispatchDrain } = await import('../src/watcher-reviewer-dispatch.mjs');
  const { meteredExecFile } = await import('../src/metered-gh.mjs');
  const root = mkdtempSync(join(tmpdir(), 'admission-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { env: { GHO_RATE_LIMIT_SHARED_STATE_PATH: join(root, 'rate-state.json') } };
  let checks = 0, freshness = 0;
  const exec = async (_command, request) => {
    if (request.at(-1) === 'headRefOid,statusCheckRollup') checks++;
    else freshness++;
    return { stdout: '{}', stderr: '' };
  };
  const drain = createReviewerDispatchDrain({
    reviewerPoolConfig: { enabled: true, maxConcurrent: 2 },
    reviewerDispatchCandidates: [{}, {}],
    detachedReviewerDispatchTracker: { activeCounts: () => ({}) },
    readWatcherDrainState: () => ({ active: false }),
    resolveGeminiCredentialConcurrencyForDispatchCandidates: async () => 1,
    prepareSpillover: async candidates => candidates,
    async runQueue(candidates) {
      await Promise.all(candidates.map(async () => {
        await meteredExecFile(exec, 'gh', args, options);
        await meteredExecFile(exec, 'gh', ['pr', 'view', '1', '--json', 'headRefOid,state,labels'], options);
      }));
      return { dispatched: 0, deferred: 0 };
    }, logger: { log() {}, warn() {} },
  });
  await drain('test');
  assert.equal(checks, 1); assert.equal(freshness, 2);
  await drain('test');
  assert.equal(checks, 2); assert.equal(freshness, 4);
});
