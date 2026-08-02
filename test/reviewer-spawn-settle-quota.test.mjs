import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { spawnReviewer } from '../src/reviewer-spawn-settle.mjs';

async function withStatusFile(state, fn, { invalidJson = false } = {}) {
  const statusDir = await mkdtemp(join(tmpdir(), 'reviewer-quota-'));
  try {
    await writeFile(
      join(statusDir, 'anthropic-oauth.status.json'),
      invalidJson ? '{ invalid json' : `${JSON.stringify({ state, authPath: 'oauth' })}\n`,
      'utf8',
    );
    return await fn(statusDir);
  } finally {
    await rm(statusDir, { recursive: true, force: true });
  }
}

function spawnArgs({ env, capture }) {
  return {
    repo: 'laceyenterprises/demo',
    prNumber: 99,
    reviewerModel: 'claude-code',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    reviewerHeadSha: 'deadbeef',
    reviewerSessionUuid: randomUUID(),
    reviewAttemptNumber: 1,
    reviewDbAttemptNumber: 1,
    maxRemediationRounds: 2,
    quotaCheckEnv: env,
    reviewerRuntimeAdapterOverride: {
      async spawnReviewer() {
        capture.spawnCalls += 1;
        return { ok: true, reviewBody: 'test', reviewBodyDelivery: 'adapter' };
      },
    },
    beginReviewerPassImpl(_rootDir, args) {
      capture.begun.push(args);
    },
    async completeReviewerPassImpl(_rootDir, args) {
      capture.completed.push(args);
    },
    postGitHubReviewWithCaptureImpl: async () => {},
    readBestReviewerEvidenceTokenUsageImpl: async () => null,
    ledgerLookupSleepImpl: async () => {},
  };
}

function newCapture() {
  return { spawnCalls: 0, begun: [], completed: [] };
}

test('known-exhausted reviewer skips spawn and records a terminal quota pass', async () => {
  await withStatusFile('EXHAUSTED', async (statusDir) => {
    const capture = newCapture();
    const result = await spawnReviewer(spawnArgs({
      env: {
        AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'true',
        AGENT_OS_REVIEWER_QUOTA_STATUS_DIR: statusDir,
      },
      capture,
    }));

    assert.equal(capture.spawnCalls, 0);
    assert.equal(capture.begun.length, 1);
    assert.equal(capture.begun[0].reviewerClass, 'claude');
    assert.equal(capture.begun[0].reviewerModel, 'claude-code');
    assert.equal(capture.completed.length, 1);
    assert.equal(capture.completed[0].status, 'skipped');
    assert.equal(capture.completed[0].metadata.failureClass, 'quota-exhausted');
    assert.equal(capture.completed[0].metadata.quotaReason, 'known-exhausted-provider-status');
    assert.equal(capture.completed[0].metadata.quotaState, 'exhausted');
    assert.equal(result.reason, 'primary-reviewer-quota-capped');
    assert.equal(result.failureClass, 'quota-exhausted');
    assert.equal(result.transient, true);
  });
});

test('healthy reviewer status dispatches normally', async () => {
  await withStatusFile('ok', async (statusDir) => {
    const capture = newCapture();
    const result = await spawnReviewer(spawnArgs({
      env: { AGENT_OS_REVIEWER_QUOTA_STATUS_DIR: statusDir },
      capture,
    }));
    assert.equal(capture.spawnCalls, 1);
    assert.equal(result.ok, true);
    assert.equal(capture.begun[0].reviewerClass, 'claude');
    assert.equal(capture.begun[0].reviewerModel, 'claude-code');
    assert.equal(capture.completed[0].status, 'completed');
  });
});

test('unreadable reviewer status fails open and dispatches normally', async () => {
  await withStatusFile('unused', async (statusDir) => {
    const capture = newCapture();
    const result = await spawnReviewer(spawnArgs({
      env: { AGENT_OS_REVIEWER_QUOTA_STATUS_DIR: statusDir },
      capture,
    }));
    assert.equal(capture.spawnCalls, 1);
    assert.equal(result.ok, true);
  }, { invalidJson: true });
});

test('unexpected quota probe exception fails open and dispatches normally', async () => {
  const capture = newCapture();
  const args = spawnArgs({ env: {}, capture });
  const result = await spawnReviewer({
    ...args,
    async readReviewerQuotaDecisionImpl() {
      throw new Error('transient probe failure');
    },
  });
  assert.equal(capture.spawnCalls, 1);
  assert.equal(result.ok, true);
});

test('unknown reviewer status fails open and dispatches normally', async () => {
  await withStatusFile('unknown', async (statusDir) => {
    const capture = newCapture();
    const result = await spawnReviewer(spawnArgs({
      env: { AGENT_OS_REVIEWER_QUOTA_STATUS_DIR: statusDir },
      capture,
    }));
    assert.equal(capture.spawnCalls, 1);
    assert.equal(result.ok, true);
  });
});

for (const [name, disabledEnv] of [
  ['canonical kill switch', { AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'false' }],
  ['legacy kill-switch alias', { ADVERSARIAL_REVIEW_QUOTA_CHECK_ENABLED: 'false' }],
]) {
  test(`${name} bypasses an exhausted status`, async () => {
    await withStatusFile('exhausted', async (statusDir) => {
      const capture = newCapture();
      const result = await spawnReviewer(spawnArgs({
        env: { ...disabledEnv, AGENT_OS_REVIEWER_QUOTA_STATUS_DIR: statusDir },
        capture,
      }));
      assert.equal(capture.spawnCalls, 1);
      assert.equal(result.ok, true);
    });
  });
}
