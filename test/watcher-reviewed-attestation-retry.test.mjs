import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  WATCHER_REVIEWED_ATTESTATION_RETRY_MAX_ENTRIES_PER_TICK,
  drainPendingReviewedAttestationRetryForTests,
  retryPendingReviewedAttestationQueueForWatcher,
  startPendingReviewedAttestationRetryForWatcher,
} from '../src/watcher-tick-preflight.mjs';

test('watcher injects hq execution dependencies when retrying reviewed attestations', () => {
  const watcherSrc = readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8');
  const callStart = watcherSrc.indexOf('startPendingReviewedAttestationRetryForWatcher({');
  assert.notEqual(callStart, -1);
  const callSource = watcherSrc.slice(callStart, watcherSrc.indexOf('});', callStart));

  assert.match(callSource, /rootDir:\s*ROOT/);
  assert.match(callSource, /hqPath:\s*process\.env\.HQ_BIN\s*\|\|\s*'hq'/);
  assert.match(callSource, /execFileImpl:\s*execFileAsync/);
  assert.match(callSource, /env:\s*process\.env/);
});

test('watcher starts one background drain and does not await it on the poll path', async () => {
  let resolveDrain;
  let calls = 0;
  const first = startPendingReviewedAttestationRetryForWatcher({
    retryPendingReviewedAttestationsImpl: async ({ maxEntriesPerRun, maxMillisPerRun }) => {
      calls += 1;
      assert.equal(maxEntriesPerRun, WATCHER_REVIEWED_ATTESTATION_RETRY_MAX_ENTRIES_PER_TICK);
      assert.equal(maxMillisPerRun, Number.POSITIVE_INFINITY);
      await new Promise((resolve) => { resolveDrain = resolve; });
      // Ten 3-second sign+record operations fit in this one background drain;
      // their 30 seconds never extend the poll's critical path.
      return { attempted: 10, consumed: 10, remaining: 0 };
    },
    log: { log() {}, warn: assert.fail },
  });
  await Promise.resolve();
  const second = startPendingReviewedAttestationRetryForWatcher({
    retryPendingReviewedAttestationsImpl: assert.fail,
  });

  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(second.reason, 'in-flight');
  assert.equal(calls, 1);
  resolveDrain();
  await drainPendingReviewedAttestationRetryForTests();
  assert.deepEqual(await first.promise, { attempted: 10, consumed: 10, remaining: 0 });
});

test('reviewed attestation retry helper logs consumed queue entries', async () => {
  const messages = [];
  const result = await retryPendingReviewedAttestationQueueForWatcher({
    rootDir: '/fixture/root',
    hqPath: '/fixture/hq',
    execFileImpl: async () => ({ stdout: '{}' }),
    env: { FOO: 'bar' },
    log: { log: (message) => messages.push(String(message)), warn: assert.fail },
    retryPendingReviewedAttestationsImpl: async (args) => {
      assert.equal(args.rootDir, '/fixture/root');
      assert.equal(args.hqPath, '/fixture/hq');
      assert.equal(args.env.FOO, 'bar');
      assert.equal(args.maxEntriesPerRun, WATCHER_REVIEWED_ATTESTATION_RETRY_MAX_ENTRIES_PER_TICK);
      return { attempted: 2, consumed: 1, remaining: 1 };
    },
  });

  assert.deepEqual(result, { attempted: 2, consumed: 1, remaining: 1 });
  assert.match(messages.join('\n'), /attempted=2 consumed=1 remaining=1/);
});

test('reviewed attestation retry helper logs pure terminal queue ticks', async () => {
  const messages = [];
  const result = await retryPendingReviewedAttestationQueueForWatcher({
    rootDir: '/fixture/root',
    hqPath: '/fixture/hq',
    execFileImpl: async () => ({ stdout: '{}' }),
    env: {},
    log: { log: (message) => messages.push(String(message)), warn: assert.fail },
    retryPendingReviewedAttestationsImpl: async () => ({
      attempted: 0,
      consumed: 0,
      remaining: 0,
      terminal: 2,
    }),
  });

  assert.deepEqual(result, { attempted: 0, consumed: 0, remaining: 0, terminal: 2 });
  assert.match(messages.join('\n'), /attempted=0 consumed=0 remaining=0 terminal=2/);
});
