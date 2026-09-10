import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  WATCHER_REVIEWED_ATTESTATION_RETRY_MAX_ENTRIES_PER_TICK,
  retryPendingReviewedAttestationQueueForWatcher,
} from '../src/watcher-tick-preflight.mjs';

test('watcher injects hq execution dependencies when retrying reviewed attestations', () => {
  const watcherSrc = readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8');
  const callStart = watcherSrc.indexOf('retryPendingReviewedAttestationQueueForWatcher({');
  assert.notEqual(callStart, -1);
  const callSource = watcherSrc.slice(callStart, watcherSrc.indexOf('});', callStart));

  assert.match(callSource, /rootDir:\s*ROOT/);
  assert.match(callSource, /hqPath:\s*process\.env\.HQ_BIN\s*\|\|\s*'hq'/);
  assert.match(callSource, /execFileImpl:\s*execFileAsync/);
  assert.match(callSource, /env:\s*process\.env/);
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
