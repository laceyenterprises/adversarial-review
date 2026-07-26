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

test('slack-thread comms adapter delivers review verdicts through Slack client and records stable JSONL ledger', async () => {
  const rootDir = makeRootDir();
  const slackMessages = [];
  const adapter = createSlackThreadCommsAdapter({
    rootDir,
    slackClient: {
      async postMessage(message) {
        slackMessages.push(message);
        return { deliveryExternalId: 'slack:C123:1715451000.000001' };
      },
    },
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
  const expectedDeliveryExternalId = 'slack:C123:1715451000.000001';

  assert.deepEqual(receipt, {
    key: makeKey(),
    deliveryExternalId: expectedDeliveryExternalId,
    deliveredAt: '2026-05-11T18:10:00.000Z',
  });
  assert.equal(slackMessages.length, 1);
  assert.deepEqual(slackMessages[0], {
    key: makeKey(),
    text: verdict.body,
    payload: {
      type: 'reviewer-verdict',
      verdict,
    },
  });
  assert.deepEqual(await adapter.lookupExistingDeliveries(makeKey()), [{
    key: makeKey(),
    deliveryExternalId: expectedDeliveryExternalId,
    attemptedAt: '2026-05-11T18:10:00.000Z',
    deliveredAt: '2026-05-11T18:10:00.000Z',
    delivered: true,
  }]);

  const lines = readFileSync(path.join(rootDir, '.slack-thread-transcripts', 'subject.md', 'slack-thread.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(lines, [
    stableStringify({
      adapter: 'comms-slack-thread',
      attemptedAt: '2026-05-11T18:10:00.000Z',
      delivered: true,
      deliveredAt: '2026-05-11T18:10:00.000Z',
      deliveryExternalId: expectedDeliveryExternalId,
      key: makeKey(),
      payload: {
        type: 'reviewer-verdict',
        verdict,
      },
    }),
  ]);
});

test('slack-thread comms adapter delivers remediation replies and deduplicates repeated keys before external write', async () => {
  const rootDir = makeRootDir();
  const slackMessages = [];
  const adapter = createSlackThreadCommsAdapter({
    rootDir,
    slackClient: {
      async postMessage(message) {
        slackMessages.push(message);
        return { deliveryExternalId: `slack:C123:1715451000.00000${slackMessages.length}` };
      },
    },
    now: () => new Date('2026-05-11T18:10:00.000Z'),
  });
  const reply = {
    kind: 'adversarial-review-remediation-reply',
    schemaVersion: 1,
    jobId: 'job-research-1',
    outcome: 'completed',
    summary: 'Qualified the causal claim.',
    validation: ['Checked subject.md'],
    addressed: [{
      title: 'Unsupported retention claim',
      finding: 'Claim overstates weak evidence.',
      action: 'Qualified the claim.',
      files: ['subject.md'],
    }],
    pushback: [],
    blockers: [],
    reReview: {
      requested: true,
      reason: 'Ready for rereview.',
    },
  };
  const key = makeKey({ kind: 'remediation-reply' });

  const first = await adapter.postRemediationReply(reply, key);
  const second = await adapter.postRemediationReply(reply, key);

  assert.deepEqual(second, first);
  assert.equal(slackMessages.length, 1);
  assert.match(slackMessages[0].text, /Qualified the causal claim/);
  const lines = readFileSync(path.join(rootDir, '.slack-thread-transcripts', 'subject.md', 'slack-thread.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
});

test('slack-thread comms adapter serializes concurrent retries for one delivery key', async () => {
  const rootDir = makeRootDir();
  const slackMessages = [];
  const adapter = createSlackThreadCommsAdapter({
    rootDir,
    slackClient: {
      async postMessage(message) {
        slackMessages.push(message);
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { deliveryExternalId: 'slack:C123:1715451000.000004' };
      },
    },
    now: () => new Date('2026-05-11T18:10:00.000Z'),
  });
  const verdict = {
    kind: 'request-changes',
    body: '## Summary\nNeeds evidence.\n\n## Verdict\nRequest changes',
  };

  const [first, second] = await Promise.all([
    adapter.postReview(verdict, makeKey()),
    adapter.postReview(verdict, makeKey()),
  ]);

  assert.deepEqual(second, first);
  assert.equal(slackMessages.length, 1);
  const lines = readFileSync(path.join(rootDir, '.slack-thread-transcripts', 'subject.md', 'slack-thread.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
});

test('slack-thread comms adapter redacts secrets and host paths before Slack write and ledger persistence', async () => {
  const rootDir = makeRootDir();
  const slackMessages = [];
  const adapter = createSlackThreadCommsAdapter({
    rootDir,
    slackClient: {
      async postMessage(message) {
        slackMessages.push(message);
        return { deliveryExternalId: 'slack:C123:1715451000.000002' };
      },
    },
    now: () => new Date('2026-05-11T18:10:00.000Z'),
  });
  const verdict = {
    kind: 'request-changes',
    body: 'Failure used Bearer abc.def-ghi at /Users/airlock/agent-os-hq/secret.txt and sk-testsecret123',
    summary: 'api_key=supersecret123 at /private/var/folders/zz/cache/output.log',
  };

  await adapter.postReview(verdict, makeKey());

  assert.equal(slackMessages.length, 1);
  assert.doesNotMatch(slackMessages[0].text, /abc\.def-ghi|airlock|agent-os-hq|sk-testsecret123/);
  assert.match(slackMessages[0].text, /Bearer \[REDACTED\]/);
  assert.match(slackMessages[0].text, /<path-redacted>\/secret\.txt/);
  const transcript = readFileSync(path.join(rootDir, '.slack-thread-transcripts', 'subject.md', 'slack-thread.jsonl'), 'utf8');
  assert.doesNotMatch(transcript, /abc\.def-ghi|airlock|agent-os-hq|sk-testsecret123|supersecret123/);
  assert.match(transcript, /\[REDACTED_OPENAI_TOKEN\]/);
  assert.match(transcript, /<path-redacted>\/output\.log/);
});

test('slack-thread comms adapter requires stable operator notice identity', async () => {
  const rootDir = makeRootDir();
  const adapter = createSlackThreadCommsAdapter({
    rootDir,
    slackClient: {
      async postMessage() {
        return { deliveryExternalId: 'slack:C123:1715451000.000003' };
      },
    },
  });

  await assert.rejects(
    () => adapter.postOperatorNotice(
      { subjectRef: makeKey(), revisionRef: 'sha256:fixture', observedAt: '2026-05-11T18:10:00.000Z' },
      'halted',
      makeKey({ kind: 'operator-notice' }),
    ),
    /noticeRef or a stable operator event id\/type/,
  );
});
