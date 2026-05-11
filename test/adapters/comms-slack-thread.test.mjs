import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createSlackThreadCommsAdapter,
  stableStringify,
} from '../../src/adapters/comms/slack-thread/index.mjs';

function makeRootDir() {
  return mkdtempSync(path.join(tmpdir(), 'comms-slack-thread-'));
}

function makeKey(overrides = {}) {
  return {
    domainId: 'research-finding',
    subjectExternalId: 'subject.md',
    revisionRef: 'sha256:fixture',
    round: 1,
    kind: 'review',
    ...overrides,
  };
}

test('slack-thread comms adapter writes stable JSONL review deliveries', async () => {
  const rootDir = makeRootDir();
  const adapter = createSlackThreadCommsAdapter({
    rootDir,
    now: () => new Date('2026-05-11T18:10:00.000Z'),
  });
  assert.deepEqual(Object.keys(adapter).sort(), [
    'lookupExistingDeliveries',
    'postOperatorNotice',
    'postRemediationReply',
    'postReview',
  ].sort());
  const verdict = {
    kind: 'request-changes',
    body: '## Summary\nNeeds evidence.\n\n## Verdict\nRequest changes',
  };

  const receipt = await adapter.postReview(verdict, makeKey());

  assert.deepEqual(receipt, {
    key: makeKey(),
    deliveryExternalId: 'comms-slack-thread:1',
    deliveredAt: '2026-05-11T18:10:00.000Z',
  });
  assert.deepEqual(await adapter.lookupExistingDeliveries(makeKey()), [{
    key: makeKey(),
    deliveryExternalId: 'comms-slack-thread:1',
    attemptedAt: '2026-05-11T18:10:00.000Z',
    deliveredAt: '2026-05-11T18:10:00.000Z',
    delivered: true,
  }]);

  const lines = readFileSync(path.join(rootDir, 'slack-thread.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(lines, [
    stableStringify({
      adapter: 'comms-slack-thread',
      attemptedAt: '2026-05-11T18:10:00.000Z',
      delivered: true,
      deliveredAt: '2026-05-11T18:10:00.000Z',
      deliveryExternalId: 'comms-slack-thread:1',
      key: makeKey(),
      payload: {
        type: 'reviewer-verdict',
        verdict,
      },
    }),
  ]);
});

test('slack-thread comms adapter requires stable operator notice identity', async () => {
  const rootDir = makeRootDir();
  const adapter = createSlackThreadCommsAdapter({ rootDir });

  await assert.rejects(
    () => adapter.postOperatorNotice(
      { subjectRef: makeKey(), revisionRef: 'sha256:fixture', observedAt: '2026-05-11T18:10:00.000Z' },
      'halted',
      makeKey({ kind: 'operator-notice' }),
    ),
    /noticeRef or a stable operator event id\/type/,
  );
});
