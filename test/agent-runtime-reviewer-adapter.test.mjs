import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgentRuntimeReviewerRuntimeAdapter,
  reviewIdempotencyKey,
} from '../src/adapters/reviewer-runtime/agent-runtime/index.mjs';
import { readReviewerRunRecord } from '../src/adapters/reviewer-runtime/run-state.mjs';
import { loadDomainConfig } from '../src/domain-config.mjs';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'agent-runtime-reviewer-adapter-'));
}

function reviewerReq(overrides = {}) {
  return {
    model: 'claude-code',
    prompt: '',
    subjectContext: {
      domainId: 'code-pr',
      repo: 'laceyenterprises/demo',
      prNumber: 42,
      reviewerHeadSha: 'abc123',
      reviewAttemptNumber: 2,
      reviewDbAttemptNumber: 2,
      completedRemediationRounds: 1,
      maxRemediationRounds: 3,
      linearTicketId: 'PRD-01',
    },
    timeoutMs: 600_000,
    sessionUuid: 'watcher-session-1',
    forbiddenFallbacks: ['api-key'],
    ...overrides,
  };
}

function completedRuntime({ calls = [], body = '## Verdict\nComment only' } = {}) {
  return {
    async run(request) {
      calls.push(request);
      return {
        runRef: request.idempotencyKey,
        mode: 'os',
        async await() {
          return {
            status: 'completed',
            artifact: {
              kind: 'review',
              body,
              reattachToken: request.idempotencyKey,
            },
            failureClass: null,
            usage: { total: 123 },
            runtimeMode: 'os',
          };
        },
        async cancel() {},
        async reattach() {
          throw new Error('live handle reattach should not be used after completion');
        },
      };
    },
    describe() {
      return { id: 'fixture-agent-runtime', mode: 'os', capabilities: {} };
    },
  };
}

test('agent-runtime reviewer adapter returns the legacy spawnReviewer result shape', async () => {
  const rootDir = makeRoot();
  const calls = [];
  try {
    const adapter = createAgentRuntimeReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'code-pr' },
      agentRuntime: completedRuntime({ calls }),
      now: () => new Date('2026-07-26T10:00:00.000Z'),
    });
    const req = reviewerReq();
    const result = await adapter.spawnReviewer(req);

    assert.equal(result.ok, true);
    assert.equal(result.reviewBody, '## Verdict\nComment only');
    assert.equal(result.failureClass, null);
    assert.equal(result.reattachToken, calls[0].idempotencyKey);
    assert.equal(result.tokenUsage.total, 123);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].role.kind, 'reviewer');
    assert.equal(calls[0].role.model, 'claude-code');
    assert.equal(calls[0].promptSet, 'code-pr');
    assert.equal(calls[0].promptStage, 'middle');
    assert.equal(calls[0].subjectContent.ref.subjectExternalId, 'laceyenterprises/demo#42');
    assert.equal(
      calls[0].idempotencyKey,
      reviewIdempotencyKey(req, { roleId: 'reviewer:claude-code' }),
    );

    const record = readReviewerRunRecord(rootDir, 'watcher-session-1');
    assert.equal(record.state, 'completed');
    assert.equal(record.runtime, 'agent-runtime');
    assert.equal(record.reattachToken, calls[0].idempotencyKey);
    assert.equal(record.subjectContext.agentRuntimeMode, 'os');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-runtime reviewer adapter reattaches an in-flight dispatch without issuing a duplicate run', async () => {
  const rootDir = makeRoot();
  const calls = { run: 0, reattach: 0 };
  try {
    const adapter = createAgentRuntimeReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'code-pr' },
      agentRuntime: {
        async run() {
          calls.run += 1;
          throw new Error('reattach must not dispatch a new run');
        },
        async reattach(record) {
          calls.reattach += 1;
          assert.equal(record.reattachToken, 'code-pr:laceyenterprises/demo#42:abc123:review:reviewer:claude-code:2');
          return {
            status: 'completed',
            artifact: { kind: 'review', body: '## Verdict\nApprove' },
            failureClass: null,
            usage: null,
            runtimeMode: 'os',
          };
        },
        describe() {
          return { id: 'fixture-agent-runtime', mode: 'os', capabilities: {} };
        },
      },
    });
    const record = {
      sessionUuid: 'watcher-session-2',
      domain: 'code-pr',
      runtime: 'agent-runtime',
      state: 'heartbeating',
      pgid: null,
      spawnedAt: '2026-07-26T10:00:00.000Z',
      lastHeartbeatAt: '2026-07-26T10:01:00.000Z',
      reattachToken: 'code-pr:laceyenterprises/demo#42:abc123:review:reviewer:claude-code:2',
      subjectContext: {
        agentRoleKind: 'reviewer',
        reviewerModel: 'claude-code',
        agentRuntimeMode: 'os',
      },
    };

    const result = await adapter.reattach(record);
    assert.equal(result.ok, true);
    assert.equal(result.reviewBody, '## Verdict\nApprove');
    assert.deepEqual(calls, { run: 0, reattach: 1 });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-runtime reviewer adapter fails closed when a completed run has no review body', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createAgentRuntimeReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'code-pr' },
      agentRuntime: completedRuntime({ body: '' }),
    });

    const result = await adapter.spawnReviewer(reviewerReq({ sessionUuid: 'watcher-session-empty' }));
    assert.equal(result.ok, false);
    assert.equal(result.reviewBody, null);
    assert.equal(result.failureClass, 'reviewer-output');
    assert.equal(readReviewerRunRecord(rootDir, 'watcher-session-empty').state, 'failed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('production code-pr domain is wired to the AgentRuntime port', () => {
  const config = loadDomainConfig(process.cwd(), 'code-pr');
  assert.equal(config.reviewerRuntime, 'agent-runtime');
});
