import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __test__ as reviewerTest } from '../src/reviewer.mjs';
import {
  clearReviewerFence,
  DEFAULT_SIGTERM_FENCE_GRACE_SECONDS,
  EXIT_TIMEOUT_SAFETY_SECONDS,
  inspectWatcherExitTimeout,
  listCleanupJobs,
  openReviewerFence,
  parseExitTimeOutFromPlist,
  probeFenceLock,
  readFenceDirAuditEvents,
  resolveFenceQuarantineDir,
  resolveFencePaths,
  validateFenceConfig,
  validateWatcherExitTimeout,
  loadSpawnRecords,
  upsertSpawnRecord,
} from '../src/reviewer-fence.mjs';
import {
  processQueuedFenceCleanupJobs,
  sweepReviewerFencesOnStartup,
  waitForActiveReviewerFencesOnSigterm,
} from '../src/watcher.mjs';

const { isReviewerPostAuthFailure, postGitHubReview } = reviewerTest;
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function makeRootDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

async function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('reviewer-side fence is present during gh review post and deleted after success', async () => {
  const rootDir = makeRootDir('reviewer-fence-success-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const spawnToken = '11111111-1111-4111-8111-111111111111';
    await withEnv({
      GH_CLAUDE_REVIEWER_TOKEN: 'ghp_test',
      ADVERSARIAL_REVIEW_STATE_DIR: stateDir,
    }, async () => {
      await postGitHubReview(
        'laceyenterprises/adversarial-review',
        177,
        'body',
        'GH_CLAUDE_REVIEWER_TOKEN',
        async () => {
          const { jsonPath, lockPath } = resolveFencePaths(stateDir, spawnToken);
          assert.equal(existsSync(jsonPath), true);
          assert.equal(existsSync(lockPath), true);
          assert.equal(probeFenceLock(lockPath).status, 'held');
        },
        {
          rootDir,
          reviewerSpawnToken: spawnToken,
          reviewerIdentity: 'claude-reviewer-lacey',
          prepareReviewWrite: async () => ({ cleared: 0 }),
        },
      );
    });
    const { jsonPath, lockPath } = resolveFencePaths(stateDir, spawnToken);
    assert.equal(existsSync(jsonPath), false);
    assert.equal(existsSync(lockPath), false);
    const events = readFenceDirAuditEvents(stateDir).map((entry) => entry.event);
    assert.deepEqual(events, ['fence_open', 'fence_clear']);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reviewer-side fence is deleted after failed gh review post without draft handoff', async () => {
  const rootDir = makeRootDir('reviewer-fence-failure-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const spawnToken = '22222222-2222-4222-8222-222222222222';
    await withEnv({
      GH_CLAUDE_REVIEWER_TOKEN: 'ghp_test',
      ADVERSARIAL_REVIEW_STATE_DIR: stateDir,
    }, async () => {
      await assert.rejects(
        () => postGitHubReview(
          'laceyenterprises/adversarial-review',
          177,
          'body',
          'GH_CLAUDE_REVIEWER_TOKEN',
          async () => {
            const { jsonPath } = resolveFencePaths(stateDir, spawnToken);
            assert.equal(existsSync(jsonPath), true);
            throw new Error('boom');
          },
          {
            rootDir,
            reviewerSpawnToken: spawnToken,
            reviewerIdentity: 'claude-reviewer-lacey',
            prepareReviewWrite: async () => ({ cleared: 0 }),
          },
        ),
        /boom/,
      );
    });
    const { jsonPath, lockPath } = resolveFencePaths(stateDir, spawnToken);
    assert.equal(existsSync(jsonPath), false);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reviewer post auth classifier avoids broad author/auth substring matches', () => {
  assert.equal(
    isReviewerPostAuthFailure(new Error('GraphQL: author cannot review this pull request'), {
      preWriteSaw401: true,
    }),
    false,
  );
  assert.equal(
    isReviewerPostAuthFailure(new Error('gh: authentication required')),
    true,
  );
  assert.equal(
    isReviewerPostAuthFailure(new Error('credential expired during gh auth probe'), {
      preWriteSaw401: true,
    }),
    true,
  );
});

test('postGitHubReview refreshes the reviewer App token once after a 401 and retries the post once', async () => {
  const rootDir = makeRootDir('reviewer-post-refresh-retry-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const prepareTokens = [];
    const ghTokens = [];
    let brokerCalls = 0;
    let ghCalls = 0;
    await withEnv({
      GH_CLAUDE_REVIEWER_TOKEN: 'ghs_stale_token',
      CLAUDE_REVIEWER_AUTH_VIA_BROKER: 'true',
      OAUTH_BROKER_CLAUDE_REVIEWER_EXPECTED_APP_ID: '111',
      OAUTH_BROKER_CLAUDE_REVIEWER_EXPECTED_INSTALLATION_ID: '42',
      OAUTH_BROKER_SHARED_SECRET_FILE: '/secret/oauth-broker-shared-secret',
      ADVERSARIAL_REVIEW_STATE_DIR: stateDir,
    }, async () => {
      await postGitHubReview(
        'laceyenterprises/adversarial-review',
        177,
        'body',
        'GH_CLAUDE_REVIEWER_TOKEN',
        async (_command, _args, options) => {
          ghCalls += 1;
          ghTokens.push(options.env.GH_TOKEN);
          if (ghCalls === 1) {
            const err = new Error('gh review failed');
            err.stderr = 'HTTP 401 Unauthorized';
            throw err;
          }
          return { stdout: '', stderr: '' };
        },
        {
          rootDir,
          reviewerIdentity: 'claude-reviewer-lacey',
          prepareReviewWrite: async ({ token, log }) => {
            prepareTokens.push(token);
            if (prepareTokens.length === 1) {
              log.warn?.('[reviewer-pre-write] self-login probe returned HTTP 401');
            }
            return { cleared: 0, listed: 0 };
          },
          fetchImpl: async (url) => {
            brokerCalls += 1;
            assert.match(url, /\/token\?provider=github-app-claude-reviewer$/);
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  access_token: 'ghs_fresh_token',
                  provider: 'github-app-claude-reviewer',
                  metadata: { app_id: '111', installation_id: '42' },
                  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                };
              },
            };
          },
          readFileImpl: () => 'broker-shared-secret',
        },
      );
    });
    assert.equal(brokerCalls, 1);
    assert.equal(ghCalls, 2);
    assert.deepEqual(prepareTokens, ['ghs_stale_token', 'ghs_fresh_token']);
    assert.deepEqual(ghTokens, ['ghs_stale_token', 'ghs_fresh_token']);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('postGitHubReview refreshes Gemini by botTokenEnv even when reviewerIdentity is stale', async () => {
  const rootDir = makeRootDir('reviewer-post-gemini-refresh-retry-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const prepareTokens = [];
    const ghTokens = [];
    let brokerCalls = 0;
    let ghCalls = 0;
    await withEnv({
      GH_GEMINI_REVIEWER_TOKEN: 'ghs_stale_gemini',
      GH_CLAUDE_REVIEWER_TOKEN: 'ghs_stale_claude',
      GEMINI_REVIEWER_AUTH_VIA_BROKER: 'true',
      CLAUDE_REVIEWER_AUTH_VIA_BROKER: 'true',
      OAUTH_BROKER_GEMINI_REVIEWER_EXPECTED_APP_ID: '222',
      OAUTH_BROKER_GEMINI_REVIEWER_EXPECTED_INSTALLATION_ID: '84',
      OAUTH_BROKER_SHARED_SECRET_FILE: '/secret/oauth-broker-shared-secret',
      ADVERSARIAL_REVIEW_STATE_DIR: stateDir,
      GEMINI_REVIEWER_GH_TOKEN: undefined,
    }, async () => {
      await postGitHubReview(
        'laceyenterprises/adversarial-review',
        177,
        'body',
        'GH_GEMINI_REVIEWER_TOKEN',
        async (_command, _args, options) => {
          ghCalls += 1;
          ghTokens.push(options.env.GH_TOKEN);
          if (ghCalls === 1) {
            const err = new Error('gh review failed');
            err.stderr = 'HTTP 401 Unauthorized';
            throw err;
          }
          return { stdout: '', stderr: '' };
        },
        {
          rootDir,
          reviewerIdentity: 'claude-reviewer-lacey',
          prepareReviewWrite: async ({ token, log }) => {
            prepareTokens.push(token);
            if (prepareTokens.length === 1) {
              log.warn?.('[reviewer-pre-write] self-login probe returned HTTP 401');
            }
            return { cleared: 0, listed: 0 };
          },
          fetchImpl: async (url) => {
            brokerCalls += 1;
            assert.match(url, /\/token\?provider=github-app-gemini-reviewer$/);
            assert.doesNotMatch(url, /github-app-claude-reviewer/);
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  access_token: 'ghs_fresh_gemini',
                  provider: 'github-app-gemini-reviewer',
                  metadata: { app_id: '222', installation_id: '84' },
                  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                };
              },
            };
          },
          readFileImpl: () => 'broker-shared-secret',
        },
      );
    });
    assert.equal(brokerCalls, 1);
    assert.equal(ghCalls, 2);
    assert.deepEqual(prepareTokens, ['ghs_stale_gemini', 'ghs_fresh_gemini']);
    assert.deepEqual(ghTokens, ['ghs_stale_gemini', 'ghs_fresh_gemini']);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('postGitHubReview degrades to the existing failure path when the refreshed token cannot be resolved', async () => {
  const rootDir = makeRootDir('reviewer-post-refresh-fails-');
  try {
    const stateDir = path.join(rootDir, 'data');
    let ghCalls = 0;
    let brokerCalls = 0;
    await withEnv({
      GH_CLAUDE_REVIEWER_TOKEN: 'ghs_stale_token',
      CLAUDE_REVIEWER_AUTH_VIA_BROKER: 'true',
      OAUTH_BROKER_SHARED_SECRET_FILE: '/secret/oauth-broker-shared-secret',
      ADVERSARIAL_REVIEW_STATE_DIR: stateDir,
    }, async () => {
      await assert.rejects(
        () => postGitHubReview(
          'laceyenterprises/adversarial-review',
          177,
          'body',
          'GH_CLAUDE_REVIEWER_TOKEN',
          async () => {
            ghCalls += 1;
            const err = new Error('gh review failed');
            err.stderr = 'HTTP 401 Unauthorized';
            throw err;
          },
          {
            rootDir,
            reviewerIdentity: 'claude-reviewer-lacey',
            prepareReviewWrite: async ({ log }) => {
              log.warn?.('[reviewer-pre-write] self-login probe returned HTTP 401');
              return { cleared: 0, listed: 0 };
            },
            fetchImpl: async () => {
              brokerCalls += 1;
              throw new Error('broker down');
            },
            readFileImpl: () => 'broker-shared-secret',
          },
        ),
        /gh review failed/,
      );
    });
    assert.equal(ghCalls, 1);
    assert.equal(brokerCalls, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('postGitHubReview does not refresh or retry on non-401 post failures', async () => {
  const rootDir = makeRootDir('reviewer-post-no-refresh-');
  try {
    const stateDir = path.join(rootDir, 'data');
    let brokerCalls = 0;
    let ghCalls = 0;
    await withEnv({
      GH_CLAUDE_REVIEWER_TOKEN: 'ghs_stale_token',
      CLAUDE_REVIEWER_AUTH_VIA_BROKER: 'true',
      OAUTH_BROKER_SHARED_SECRET_FILE: '/secret/oauth-broker-shared-secret',
      ADVERSARIAL_REVIEW_STATE_DIR: stateDir,
    }, async () => {
      await assert.rejects(
        () => postGitHubReview(
          'laceyenterprises/adversarial-review',
          177,
          'body',
          'GH_CLAUDE_REVIEWER_TOKEN',
          async () => {
            ghCalls += 1;
            throw new Error('GraphQL: body is invalid');
          },
          {
            rootDir,
            reviewerIdentity: 'claude-reviewer-lacey',
            prepareReviewWrite: async () => ({ cleared: 0, listed: 0 }),
            fetchImpl: async () => {
              brokerCalls += 1;
              throw new Error('should not be called');
            },
            readFileImpl: () => 'broker-shared-secret',
          },
        ),
        /body is invalid/,
      );
    });
    assert.equal(ghCalls, 1);
    assert.equal(brokerCalls, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('postGitHubReview does not refresh or retry on transient review-post transport errors', async () => {
  const rootDir = makeRootDir('reviewer-post-transient-no-retry-');
  try {
    const stateDir = path.join(rootDir, 'data');
    let brokerCalls = 0;
    let ghCalls = 0;
    await withEnv({
      GH_CLAUDE_REVIEWER_TOKEN: 'ghs_stale_token',
      CLAUDE_REVIEWER_AUTH_VIA_BROKER: 'true',
      OAUTH_BROKER_SHARED_SECRET_FILE: '/secret/oauth-broker-shared-secret',
      ADVERSARIAL_REVIEW_STATE_DIR: stateDir,
    }, async () => {
      await assert.rejects(
        () => postGitHubReview(
          'laceyenterprises/adversarial-review',
          177,
          'body',
          'GH_CLAUDE_REVIEWER_TOKEN',
          async () => {
            ghCalls += 1;
            const err = new Error('socket hang up after review mutation');
            err.code = 'ECONNRESET';
            err.stderr = 'read ECONNRESET';
            throw err;
          },
          {
            rootDir,
            reviewerIdentity: 'claude-reviewer-lacey',
            prepareReviewWrite: async ({ log }) => {
              log.warn?.('[reviewer-pre-write] self-login probe returned HTTP 401');
              return { cleared: 0, listed: 0 };
            },
            fetchImpl: async () => {
              brokerCalls += 1;
              throw new Error('should not be called');
            },
            readFileImpl: () => 'broker-shared-secret',
          },
        ),
        /socket hang up/,
      );
    });
    assert.equal(ghCalls, 1);
    assert.equal(brokerCalls, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('openReviewerFence rolls back lock file when audit write fails after flock', () => {
  const rootDir = makeRootDir('reviewer-fence-open-rollback-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const spawnToken = '23232323-2323-4232-8232-232323232323';
    assert.throws(
      () => openReviewerFence({
        stateDir,
        spawnToken,
        repo: 'laceyenterprises/adversarial-review',
        pr: 177,
        identity: 'claude-reviewer-lacey',
        auditEventWriter: () => {
          throw new Error('audit-fsync-failed');
        },
      }),
      /audit-fsync-failed/,
    );
    const { jsonPath, lockPath } = resolveFencePaths(stateDir, spawnToken);
    assert.equal(existsSync(jsonPath), false);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('openReviewerFence normalizes missing spawn tokens instead of writing null artifacts', () => {
  const rootDir = makeRootDir('reviewer-fence-null-token-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const fence = openReviewerFence({
      stateDir,
      spawnToken: null,
      repo: 'laceyenterprises/adversarial-review',
      pr: 177,
      identity: 'claude-reviewer-lacey',
    });
    assert.notEqual(fence.record.spawnToken, 'null');
    assert.notEqual(fence.record.spawnToken, '');
    assert.equal(existsSync(path.join(stateDir, 'reviewer-fences', 'null.json')), false);
    assert.equal(existsSync(path.join(stateDir, 'reviewer-fences', 'null.lock')), false);
    fence.clear();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('openReviewerFence emits rollback audit event when fence_open persistence fails', () => {
  const rootDir = makeRootDir('reviewer-fence-open-rollback-audit-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const events = [];
    assert.throws(
      () => openReviewerFence({
        stateDir,
        spawnToken: '24242424-2424-4242-8242-242424242424',
        repo: 'laceyenterprises/adversarial-review',
        pr: 177,
        identity: 'claude-reviewer-lacey',
        auditEventWriter: (_stateDir, event) => {
          events.push(event);
          if (event.event === 'fence_open') throw new Error('audit-fsync-failed');
        },
      }),
      /audit-fsync-failed/,
    );
    assert.deepEqual(events.map((event) => event.event), ['fence_open', 'fence_open_rolled_back']);
    assert.equal(events[1].error, 'audit-fsync-failed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('fs-ext flock integration: EX-held lock blocks SH|NB in another process and SH|NB succeeds after exit', async () => {
  const rootDir = makeRootDir('reviewer-fence-flock-');
  try {
    const lockPath = path.join(rootDir, 'sentinel.lock');
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const fsExt = require('fs-ext');
      const fd = fs.openSync(${JSON.stringify(lockPath)}, 'w', 0o600);
      fsExt.flockSync(fd, fsExt.constants.LOCK_EX | fsExt.constants.LOCK_NB);
      process.send?.('ready');
      setTimeout(() => process.exit(0), 750);
    `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });

    await new Promise((resolve) => holder.once('message', resolve));
    assert.equal(probeFenceLock(lockPath).status, 'held');

    await new Promise((resolve) => holder.once('exit', resolve));
    assert.equal(probeFenceLock(lockPath).status, 'free');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher SIGTERM fence wait clears normally when active fence disappears within grace', async () => {
  const rootDir = makeRootDir('watcher-fence-grace-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const fence = openReviewerFence({
      stateDir,
      spawnToken: '33333333-3333-4333-8333-333333333333',
      repo: 'laceyenterprises/adversarial-review',
      pr: 177,
      identity: 'claude-reviewer-lacey',
    });
    const activeSpawnMap = new Map([[
      fence.record.spawnToken,
      { ...fence.record, repo: 'laceyenterprises/adversarial-review', botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN' },
    ]]);
    setTimeout(() => fence.clear(), 100);
    const result = await waitForActiveReviewerFencesOnSigterm({
      stateDir,
      graceSeconds: 1,
      staleTtlSeconds: 90,
      activeSpawnMap,
    });
    assert.equal(result.status, 'cleared');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher SIGTERM fence wait queues cleanup after grace expires', async () => {
  const rootDir = makeRootDir('watcher-fence-expire-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const fence = openReviewerFence({
      stateDir,
      spawnToken: '44444444-4444-4444-8444-444444444444',
      repo: 'laceyenterprises/adversarial-review',
      pr: 188,
      identity: 'codex-reviewer-lacey',
    });
    const activeSpawnMap = new Map([[
      fence.record.spawnToken,
      { ...fence.record, repo: 'laceyenterprises/adversarial-review', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' },
    ]]);
    const result = await waitForActiveReviewerFencesOnSigterm({
      stateDir,
      graceSeconds: 1,
      staleTtlSeconds: 90,
      activeSpawnMap,
      sleepImpl: async () => {},
    });
    assert.equal(result.status, 'grace-exceeded');
    assert.equal(listCleanupJobs(stateDir).length, 1);
    fence.clear();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher SIGTERM preserve mode emits audit without queueing cleanup after grace expires', async () => {
  const rootDir = makeRootDir('watcher-fence-preserve-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const fence = openReviewerFence({
      stateDir,
      spawnToken: '44444444-4444-4444-8444-555555555555',
      repo: 'laceyenterprises/adversarial-review',
      pr: 189,
      identity: 'codex-reviewer-lacey',
    });
    const activeSpawnMap = new Map([[
      fence.record.spawnToken,
      { ...fence.record, repo: 'laceyenterprises/adversarial-review', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' },
    ]]);
    const result = await waitForActiveReviewerFencesOnSigterm({
      stateDir,
      graceSeconds: 1,
      staleTtlSeconds: 90,
      activeSpawnMap,
      queueCleanupOnGraceExpiry: false,
      sleepImpl: async () => {},
    });
    assert.equal(result.status, 'grace-exceeded');
    assert.equal(listCleanupJobs(stateDir).length, 0);
    assert.equal(readFenceDirAuditEvents(stateDir).at(-1)?.cleanupQueued, false);
    fence.clear();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher SIGTERM fence wait treats wall-clock openedAt as stale', async () => {
  const rootDir = makeRootDir('watcher-fence-stale-');
  try {
    const stateDir = path.join(rootDir, 'data');
    openReviewerFence({
      stateDir,
      spawnToken: '55555555-5555-4555-8555-555555555555',
      repo: 'laceyenterprises/adversarial-review',
      pr: 199,
      identity: 'claude-reviewer-lacey',
      openedAt: '2026-05-30T00:00:00.000Z',
    });
    const activeSpawnMap = new Map([[
      '55555555-5555-4555-8555-555555555555',
      {
        spawnToken: '55555555-5555-4555-8555-555555555555',
        repo: 'laceyenterprises/adversarial-review',
        pr: 199,
        identity: 'claude-reviewer-lacey',
        botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
      },
    ]]);
    const result = await waitForActiveReviewerFencesOnSigterm({
      stateDir,
      graceSeconds: 30,
      staleTtlSeconds: 90,
      activeSpawnMap,
    });
    assert.equal(result.status, 'stale');
    assert.equal(listCleanupJobs(stateDir).length, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher SIGTERM stale fence cleanup does not forfeit grace for healthy fences', async () => {
  const rootDir = makeRootDir('watcher-fence-stale-and-healthy-');
  try {
    const stateDir = path.join(rootDir, 'data');
    openReviewerFence({
      stateDir,
      spawnToken: '56565656-5656-4565-8565-565656565656',
      repo: 'laceyenterprises/adversarial-review',
      pr: 199,
      identity: 'claude-reviewer-lacey',
      openedAt: '2026-05-30T00:00:00.000Z',
    });
    const healthyFence = openReviewerFence({
      stateDir,
      spawnToken: '57575757-5757-4575-8575-575757575757',
      repo: 'laceyenterprises/adversarial-review',
      pr: 200,
      identity: 'claude-reviewer-lacey',
    });
    const activeSpawnMap = new Map([
      [
        '56565656-5656-4565-8565-565656565656',
        {
          spawnToken: '56565656-5656-4565-8565-565656565656',
          repo: 'laceyenterprises/adversarial-review',
          pr: 199,
          identity: 'claude-reviewer-lacey',
          botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
        },
      ],
      [
        healthyFence.record.spawnToken,
        { ...healthyFence.record, botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN' },
      ],
    ]);
    setTimeout(() => healthyFence.clear(), 100);
    const result = await waitForActiveReviewerFencesOnSigterm({
      stateDir,
      graceSeconds: 1,
      staleTtlSeconds: 90,
      activeSpawnMap,
    });
    assert.equal(result.status, 'stale');
    const cleanupJobs = listCleanupJobs(stateDir);
    assert.equal(cleanupJobs.length, 1);
    assert.equal(JSON.parse(readFileSync(cleanupJobs[0], 'utf8')).pr, 199);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('startup orphan sweep reaps flock-free fences and skips flock-held fences', async () => {
  const rootDir = makeRootDir('watcher-fence-sweep-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const freeToken = '66666666-6666-4666-8666-666666666666';
    const heldFence = openReviewerFence({
      stateDir,
      spawnToken: '88888888-8888-4888-8888-888888888888',
      repo: 'laceyenterprises/adversarial-review',
      pr: 212,
      identity: 'claude-reviewer-lacey',
    });
    const { jsonPath: freeJson, lockPath: freeLock } = resolveFencePaths(stateDir, freeToken);
    writeFileSync(freeLock, '', 'utf8');
    writeFileSync(
      freeJson,
      `${JSON.stringify({
        schemaVersion: 1,
        spawnToken: freeToken,
        repo: 'laceyenterprises/adversarial-review',
        pr: 210,
        identity: 'codex-reviewer-lacey',
        openedAt: new Date().toISOString(),
        expectedClearBy: new Date(Date.now() + 60_000).toISOString(),
      }, null, 2)}\n`,
      'utf8',
    );
    upsertSpawnRecord(stateDir, {
      spawnToken: heldFence.record.spawnToken,
      repo: 'laceyenterprises/adversarial-review',
      pr: 212,
      identity: 'claude-reviewer-lacey',
      botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    });

    const orphaned = await sweepReviewerFencesOnStartup({
      stateDir,
      staleTtlSeconds: 90,
      activeSpawnMap: new Map(),
    });
    assert.equal(orphaned, 1);
    assert.equal(existsSync(freeJson), false);
    assert.equal(probeFenceLock(resolveFencePaths(stateDir, heldFence.record.spawnToken).lockPath).status, 'held');
    assert.equal(listCleanupJobs(stateDir).length, 1);
    assert.equal(readFenceDirAuditEvents(stateDir).length > 0, true);
    heldFence.clear();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('startup orphan sweep quarantines corrupt fence json and continues sweeping', async () => {
  const rootDir = makeRootDir('watcher-fence-corrupt-json-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const badPath = path.join(stateDir, 'reviewer-fences', 'broken.json');
    const freeToken = '68686868-6868-4868-8868-686868686868';
    const { jsonPath: freeJson, lockPath: freeLock } = resolveFencePaths(stateDir, freeToken);
    writeFileSync(badPath, '{', 'utf8');
    writeFileSync(freeLock, '', 'utf8');
    writeFileSync(
      freeJson,
      `${JSON.stringify({
        schemaVersion: 1,
        spawnToken: freeToken,
        repo: 'laceyenterprises/adversarial-review',
        pr: 210,
        identity: 'codex-reviewer-lacey',
        openedAt: new Date().toISOString(),
        expectedClearBy: new Date(Date.now() + 60_000).toISOString(),
      }, null, 2)}\n`,
      'utf8',
    );

    const orphaned = await sweepReviewerFencesOnStartup({
      stateDir,
      staleTtlSeconds: 90,
      activeSpawnMap: new Map(),
    });
    assert.equal(orphaned, 1);
    assert.equal(existsSync(badPath), false);
    assert.equal(listCleanupJobs(stateDir).length, 1);
    assert.equal(readdirSync(resolveFenceQuarantineDir(stateDir)).length > 0, true);
    assert.equal(
      readFenceDirAuditEvents(stateDir).some((entry) => entry.event === 'fence_corrupted_skipped'),
      true,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('startup orphan sweep reaps stale lock files without json sidecars', async () => {
  const rootDir = makeRootDir('watcher-fence-orphan-lock-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const spawnToken = '69696969-6969-4969-8969-696969696969';
    const { lockPath } = resolveFencePaths(stateDir, spawnToken);
    writeFileSync(lockPath, '', 'utf8');
    const staleSeconds = 120;
    const staleMs = Date.now() - (staleSeconds * 1000);
    const orphaned = await sweepReviewerFencesOnStartup({
      stateDir,
      staleTtlSeconds: 90,
      activeSpawnMap: new Map(),
    });
    assert.equal(orphaned, 0);
    assert.equal(existsSync(lockPath), true);

    utimesSync(lockPath, staleMs / 1000, staleMs / 1000);
    const reaped = await sweepReviewerFencesOnStartup({
      stateDir,
      staleTtlSeconds: 90,
      activeSpawnMap: new Map(),
    });
    assert.equal(reaped, 1);
    assert.equal(existsSync(lockPath), false);
    assert.equal(
      readFenceDirAuditEvents(stateDir).some((entry) => entry.event === 'fence_orphan_lock_reaped'),
      true,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('removing fence json before unlock prevents concurrent sweep from queueing cleanup', async () => {
  const rootDir = makeRootDir('watcher-fence-clear-order-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const fence = openReviewerFence({
      stateDir,
      spawnToken: '67676767-6767-4767-8767-676767676767',
      repo: 'laceyenterprises/adversarial-review',
      pr: 214,
      identity: 'claude-reviewer-lacey',
    });
    const { jsonPath } = resolveFencePaths(stateDir, fence.record.spawnToken);
    rmSync(jsonPath, { force: true });
    const orphaned = await sweepReviewerFencesOnStartup({
      stateDir,
      staleTtlSeconds: 90,
      activeSpawnMap: new Map(),
    });
    assert.equal(orphaned, 0);
    assert.equal(listCleanupJobs(stateDir).length, 0);
    clearReviewerFence({
      stateDir,
      spawnToken: fence.record.spawnToken,
      lockFd: fence.lockFd,
      record: fence.record,
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('processQueuedFenceCleanupJobs drains queued cleanup jobs', async () => {
  const rootDir = makeRootDir('watcher-fence-cleanup-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const fence = openReviewerFence({
      stateDir,
      spawnToken: '77777777-7777-4777-8777-777777777777',
      repo: 'laceyenterprises/adversarial-review',
      pr: 211,
      identity: 'claude-reviewer-lacey',
    });
    const activeSpawnMap = new Map([[
      fence.record.spawnToken,
      { ...fence.record, repo: 'laceyenterprises/adversarial-review', botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN' },
    ]]);
    await waitForActiveReviewerFencesOnSigterm({
      stateDir,
      graceSeconds: 1,
      staleTtlSeconds: 90,
      activeSpawnMap,
      sleepImpl: async () => {},
    });
    const calls = [];
    await withEnv({ GH_CLAUDE_REVIEWER_TOKEN: 'token' }, () => processQueuedFenceCleanupJobs({
      stateDir,
      clearPendingReviewsImpl: async (args) => {
        calls.push(args);
        return { cleared: 1 };
      },
    }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].repo, 'laceyenterprises/adversarial-review');
    assert.equal(listCleanupJobs(stateDir).length, 0);
    fence.clear();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('processQueuedFenceCleanupJobs resolves Gemini cleanup jobs to the Gemini token env', async () => {
  const rootDir = makeRootDir('watcher-fence-gemini-cleanup-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const fence = openReviewerFence({
      stateDir,
      spawnToken: '88888888-8888-4888-8888-888888888888',
      repo: 'laceyenterprises/adversarial-review',
      pr: 315,
      identity: 'gemini-reviewer-lacey',
    });
    const activeSpawnMap = new Map([[
      fence.record.spawnToken,
      { ...fence.record, repo: 'laceyenterprises/adversarial-review' },
    ]]);
    await waitForActiveReviewerFencesOnSigterm({
      stateDir,
      graceSeconds: 1,
      staleTtlSeconds: 90,
      activeSpawnMap,
      sleepImpl: async () => {},
    });
    const calls = [];
    await withEnv({ GH_GEMINI_REVIEWER_TOKEN: 'gemini-token' }, () => processQueuedFenceCleanupJobs({
      stateDir,
      clearPendingReviewsImpl: async (args) => {
        calls.push(args);
        return { cleared: 1 };
      },
    }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].repo, 'laceyenterprises/adversarial-review');
    assert.equal(calls[0].token, 'gemini-token');
    assert.equal(listCleanupJobs(stateDir).length, 0);
    fence.clear();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('processQueuedFenceCleanupJobs quarantines corrupt cleanup jobs and continues', async () => {
  const rootDir = makeRootDir('watcher-fence-corrupt-cleanup-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const cleanupDir = path.join(stateDir, 'reviewer-fences', 'cleanup-jobs');
    mkdirSync(cleanupDir, { recursive: true });
    writeFileSync(path.join(cleanupDir, 'broken.json'), '{', 'utf8');
    const processed = await processQueuedFenceCleanupJobs({
      stateDir,
      clearPendingReviewsImpl: async () => {
        throw new Error('should not run');
      },
    });
    assert.equal(processed, 0);
    assert.equal(readdirSync(resolveFenceQuarantineDir(stateDir)).length > 0, true);
    assert.equal(
      readFenceDirAuditEvents(stateDir).some((entry) => entry.event === 'fence_corrupted_skipped'),
      true,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('fence config validation rejects stale_TTL below 2 * grace', () => {
  assert.throws(
    () => validateFenceConfig({
      ADVERSARIAL_REVIEW_SIGTERM_FENCE_GRACE_SECONDS: '35',
      ADVERSARIAL_REVIEW_FENCE_STALE_TTL_SECONDS: '60',
    }),
    /must be >= 2 \*/,
  );
});

test('watcher startup plist validation rejects ExitTimeOut below grace + 15', () => {
  const rootDir = makeRootDir('watcher-fence-plist-');
  try {
    const plistPath = path.join(rootDir, 'watcher.plist');
    writeFileSync(
      plistPath,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<plist version="1.0"><dict>',
        '<key>ExitTimeOut</key><integer>40</integer>',
        '</dict></plist>',
      ].join('\n'),
      'utf8',
    );
    assert.throws(
      () => validateWatcherExitTimeout({
        ADVERSARIAL_REVIEW_SIGTERM_FENCE_GRACE_SECONDS: '30',
        ADVERSARIAL_REVIEW_FENCE_STALE_TTL_SECONDS: '90',
        ADVERSARIAL_REVIEW_WATCHER_PLIST_PATH: plistPath,
      }),
      /should be >= 45/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher startup plist inspection warns instead of hard-failing when plist path is unavailable', () => {
  const result = inspectWatcherExitTimeout({
    ADVERSARIAL_REVIEW_SIGTERM_FENCE_GRACE_SECONDS: '30',
    ADVERSARIAL_REVIEW_FENCE_STALE_TTL_SECONDS: '90',
  });
  assert.equal(result.ok, false);
  assert.match(result.warning, /cannot self-validate ExitTimeOut/);
});

test('shipped watcher plist ExitTimeOut covers default grace + safety margin', () => {
  const plistPath = path.join(TEST_DIR, '..', 'launchd', 'ai.laceyenterprises.adversarial-watcher.airlock.plist');
  const exitTimeout = parseExitTimeOutFromPlist(readFileSync(plistPath, 'utf8'));
  const grace = validateFenceConfig({}).graceSeconds;
  assert.equal(exitTimeout >= Math.max(45, grace + EXIT_TIMEOUT_SAFETY_SECONDS), true);
  assert.equal(exitTimeout >= (DEFAULT_SIGTERM_FENCE_GRACE_SECONDS + EXIT_TIMEOUT_SAFETY_SECONDS), true);
});

test('token-known scope across restart uses persisted spawn-record union', async () => {
  const rootDir = makeRootDir('watcher-fence-known-scope-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const spawnToken = '99999999-9999-4999-8999-999999999999';
    const { jsonPath, lockPath } = resolveFencePaths(stateDir, spawnToken);
    writeFileSync(lockPath, '', 'utf8');
    writeFileSync(
      jsonPath,
      `${JSON.stringify({
        schemaVersion: 1,
        spawnToken,
        repo: 'laceyenterprises/adversarial-review',
        pr: 213,
        identity: 'claude-reviewer-lacey',
        openedAt: new Date().toISOString(),
        expectedClearBy: new Date(Date.now() + 60_000).toISOString(),
      }, null, 2)}\n`,
      'utf8',
    );
    upsertSpawnRecord(stateDir, {
      spawnToken,
      repo: 'laceyenterprises/adversarial-review',
      pr: 213,
      identity: 'claude-reviewer-lacey',
      botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    });
    const orphaned = await sweepReviewerFencesOnStartup({
      stateDir,
      staleTtlSeconds: 90,
      activeSpawnMap: new Map(),
    });
    assert.equal(orphaned, 1);
    assert.equal(listCleanupJobs(stateDir).length, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('concurrent upsertSpawnRecord calls from separate processes preserve both records', async () => {
  const rootDir = makeRootDir('watcher-fence-spawn-records-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const records = [
      {
        spawnToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        repo: 'laceyenterprises/adversarial-review',
        pr: 301,
        identity: 'claude-reviewer-lacey',
        botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
      },
      {
        spawnToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        repo: 'laceyenterprises/adversarial-review',
        pr: 302,
        identity: 'codex-reviewer-lacey',
        botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
      },
    ];
    await Promise.all(records.map((record) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { upsertSpawnRecord } from ${JSON.stringify(path.join(TEST_DIR, '..', 'src', 'reviewer-fence.mjs'))};
        upsertSpawnRecord(${JSON.stringify(stateDir)}, ${JSON.stringify(record)});
      `], { stdio: ['ignore', 'ignore', 'inherit'] });
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`child exited with code ${code}`));
      });
    })));
    const persisted = loadSpawnRecords(stateDir);
    assert.deepEqual(Object.keys(persisted).sort(), records.map((record) => record.spawnToken).sort());
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
