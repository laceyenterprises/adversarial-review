import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnReviewer } from '../src/reviewer-spawn-settle.mjs';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = join(tmpdir(), `test-quota-dir-${randomUUID()}`);

test('setup', () => {
  mkdirSync(tmpDir, { recursive: true });
});

test('spawnReviewer quota - known-exhausted -> skipped + terminal skipped pass', async () => {
  const originalEnv = process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED;
  const originalAliasEnv = process.env.ADVERSARIAL_REVIEW_QUOTA_CHECK_ENABLED;
  const originalDir = process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR;
  
  process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED = 'true';
  process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR = tmpDir;
  
  writeFileSync(join(tmpDir, 'anthropic-oauth.status.json'), JSON.stringify({ state: 'exhausted' }));

  try {
    let completedStatus = null;
    let spawnCalled = false;
    const result = await spawnReviewer({
      repo: 'laceyenterprises/demo',
      prNumber: 99,
      reviewerModel: 'claude',
      botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
      reviewAttemptNumber: 1,
      maxRemediationRounds: 2,
      reviewerRuntimeAdapterOverride: {
        async spawnReviewer() {
          spawnCalled = true;
          return { ok: true };
        },
      },
      completeReviewerPassImpl: async (rootDir, args) => {
        completedStatus = args.status;
      },
      postGitHubReviewWithCaptureImpl: async () => {},
      readBestReviewerEvidenceTokenUsageImpl: async () => null,
    });

    assert.equal(spawnCalled, false);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'primary-reviewer-quota-capped');
    assert.equal(result.transient, true);
    assert.equal(completedStatus, 'skipped');
  } finally {
    if (originalEnv === undefined) delete process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED; else process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED = originalEnv;
    if (originalDir === undefined) delete process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR; else process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR = originalDir;
    rmSync(join(tmpDir, 'anthropic-oauth.status.json'), { force: true });
  }
});

test('spawnReviewer quota - healthy -> normal dispatch', async () => {
  const originalEnv = process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED;
  const originalDir = process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR;
  process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED = 'true';
  process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR = tmpDir;
  
  writeFileSync(join(tmpDir, 'anthropic-oauth.status.json'), JSON.stringify({ state: 'ok' }));

  try {
    let spawnCalled = false;
    const result = await spawnReviewer({
      repo: 'laceyenterprises/demo',
      prNumber: 99,
      reviewerModel: 'claude',
      botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
      reviewAttemptNumber: 1,
      maxRemediationRounds: 2,
      reviewerRuntimeAdapterOverride: {
        async spawnReviewer() {
          spawnCalled = true;
          return { ok: true, reviewBody: 'test', reviewBodyDelivery: 'adapter' };
        },
      },
      postGitHubReviewWithCaptureImpl: async () => {},
      readBestReviewerEvidenceTokenUsageImpl: async () => null,
    });

    assert.equal(spawnCalled, true);
    assert.equal(result.ok, true);
  } finally {
    if (originalEnv === undefined) delete process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED; else process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED = originalEnv;
    if (originalDir === undefined) delete process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR; else process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR = originalDir;
    rmSync(join(tmpDir, 'anthropic-oauth.status.json'), { force: true });
  }
});

test('spawnReviewer quota - probe error -> fail-open normal dispatch', async () => {
  const originalEnv = process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED;
  const originalDir = process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR;
  process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED = 'true';
  process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR = tmpDir;
  
  // write invalid json to cause parse error
  writeFileSync(join(tmpDir, 'anthropic-oauth.status.json'), '{ invalid json');

  try {
    let spawnCalled = false;
    const result = await spawnReviewer({
      repo: 'laceyenterprises/demo',
      prNumber: 99,
      reviewerModel: 'claude',
      botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
      reviewAttemptNumber: 1,
      maxRemediationRounds: 2,
      reviewerRuntimeAdapterOverride: {
        async spawnReviewer() {
          spawnCalled = true;
          return { ok: true, reviewBody: 'test', reviewBodyDelivery: 'adapter' };
        },
      },
      postGitHubReviewWithCaptureImpl: async () => {},
      readBestReviewerEvidenceTokenUsageImpl: async () => null,
    });

    assert.equal(spawnCalled, true);
    assert.equal(result.ok, true);
  } finally {
    if (originalEnv === undefined) delete process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED; else process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED = originalEnv;
    if (originalDir === undefined) delete process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR; else process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR = originalDir;
    rmSync(join(tmpDir, 'anthropic-oauth.status.json'), { force: true });
  }
});

test('spawnReviewer quota - unknown status -> fail-open normal dispatch', async () => {
  const originalEnv = process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED;
  const originalDir = process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR;
  process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED = 'true';
  process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR = tmpDir;
  
  writeFileSync(join(tmpDir, 'anthropic-oauth.status.json'), JSON.stringify({ state: 'unknown' }));

  try {
    let spawnCalled = false;
    const result = await spawnReviewer({
      repo: 'laceyenterprises/demo',
      prNumber: 99,
      reviewerModel: 'claude',
      botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
      reviewAttemptNumber: 1,
      maxRemediationRounds: 2,
      reviewerRuntimeAdapterOverride: {
        async spawnReviewer() {
          spawnCalled = true;
          return { ok: true, reviewBody: 'test', reviewBodyDelivery: 'adapter' };
        },
      },
      postGitHubReviewWithCaptureImpl: async () => {},
      readBestReviewerEvidenceTokenUsageImpl: async () => null,
    });

    assert.equal(spawnCalled, true);
    assert.equal(result.ok, true);
  } finally {
    if (originalEnv === undefined) delete process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED; else process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED = originalEnv;
    if (originalDir === undefined) delete process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR; else process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR = originalDir;
    rmSync(join(tmpDir, 'anthropic-oauth.status.json'), { force: true });
  }
});

test('spawnReviewer quota - kill-switch disabled (ADVERSARIAL_REVIEW_QUOTA_CHECK_ENABLED alias) -> normal dispatch', async () => {
  const originalEnv = process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED;
  const originalAliasEnv = process.env.ADVERSARIAL_REVIEW_QUOTA_CHECK_ENABLED;
  const originalDir = process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR;
  
  // Set the alias and clear the canonical one
  process.env.ADVERSARIAL_REVIEW_QUOTA_CHECK_ENABLED = 'false';
  delete process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED;
  process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR = tmpDir;
  
  writeFileSync(join(tmpDir, 'anthropic-oauth.status.json'), JSON.stringify({ state: 'exhausted' }));

  try {
    let spawnCalled = false;
    const result = await spawnReviewer({
      repo: 'laceyenterprises/demo',
      prNumber: 99,
      reviewerModel: 'claude',
      botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
      reviewAttemptNumber: 1,
      maxRemediationRounds: 2,
      reviewerRuntimeAdapterOverride: {
        async spawnReviewer() {
          spawnCalled = true;
          return { ok: true, reviewBody: 'test', reviewBodyDelivery: 'adapter' };
        },
      },
      postGitHubReviewWithCaptureImpl: async () => {},
      readBestReviewerEvidenceTokenUsageImpl: async () => null,
    });

    assert.equal(spawnCalled, true);
    assert.equal(result.ok, true);
  } finally {
    if (originalAliasEnv === undefined) delete process.env.ADVERSARIAL_REVIEW_QUOTA_CHECK_ENABLED; else process.env.ADVERSARIAL_REVIEW_QUOTA_CHECK_ENABLED = originalAliasEnv;
    if (originalEnv === undefined) delete process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED; else process.env.AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED = originalEnv;
    if (originalDir === undefined) delete process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR; else process.env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR = originalDir;
    rmSync(join(tmpDir, 'anthropic-oauth.status.json'), { force: true });
  }
});

test('teardown', () => {
  rmSync(tmpDir, { recursive: true, force: true });
});
