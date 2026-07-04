// Tests for the 2026-06-09 CFG promotion of 8 adversarial-review knobs.
//
// Verifies:
//   1. Each new CFG key resolves to its hardcoded default when nothing is set.
//   2. The CFG keys are registered in ENV_ALIASES so doctor surfaces them.
//   3. Legacy env aliases still win over CFG (back-compat).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AgentOSConfigError, loadConfig, ENV_ALIASES } from '../src/config-loader.mjs';
import {
  resolveHqDispatchTimeoutMs,
  resolveHqWorkerTearDownTimeoutMs,
} from '../src/follow-up-merge-agent.mjs';
import { resolveReviewerTimeoutMs, resolveProgressTimeoutMs } from '../src/reviewer-timeout.mjs';
import { resolveFirstPassReviewerPoolConfig } from '../src/watcher-reviewer-pool.mjs';
import { normalizeMaxConcurrentFollowUpJobs, resolveRemediationMaxConcurrentJobs } from '../src/follow-up-remediation.mjs';
import {
  resolvePendingDraftRespawnAgeSeconds,
  resolveStuckDispatchAlertDebounceMs,
  resolveWatcherDrainMaxMs,
} from '../src/watcher.mjs';
import { resetRoleConfigCache } from '../src/role-config.mjs';

const ALL_NEW_FLAT_KEYS = Object.freeze([
  'remediation.max_concurrent_jobs',
  'remediation.max_concurrent_jobs_ceiling',
  'remediation.reconciliation_max_active_age_ms_before_abandon',
  'reviewer.timeout_ms',
  'reviewer.no_progress_timeout_ms',
  'watcher.max_drain_wait_ms',
  'watcher.pending_draft_review_respawn_age_seconds',
  'watcher.stuck_dispatch_alert_debounce_ms',
  'watcher.first_pass_reviewer_pool_max_concurrent_reviewers',
  'follow_up.hq_worker_tear_down_subprocess_timeout_ms',
  'follow_up.hq_dispatch_subprocess_timeout_ms',
]);

function createTempConfig(contents) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'cfg-promotion-watcher-knobs-'));
  const configPath = path.join(rootDir, 'config.yaml');
  writeFileSync(configPath, contents, 'utf8');
  return {
    configPath,
    cleanup() {
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

function assertEnvAliasConflict(fn, expectedNames) {
  assert.throws(
    fn,
    (err) => {
      assert.ok(err instanceof AgentOSConfigError, `expected AgentOSConfigError, got ${err?.name}`);
      for (const name of expectedNames) {
        assert.ok(
          err.conflictingEnvNames.includes(name),
          `expected conflict to include ${name}; got ${JSON.stringify(err.conflictingEnvNames)}`
        );
      }
      return true;
    }
  );
}

test.afterEach(() => {
  resetRoleConfigCache();
});

test('all promoted CFG keys are registered in ENV_ALIASES', () => {
  for (const key of ALL_NEW_FLAT_KEYS) {
    assert.ok(ENV_ALIASES[key], `missing ENV_ALIASES entry: ${key}`);
    assert.ok(ENV_ALIASES[key].canonical, `missing canonical env name: ${key}`);
  }
});

test('pending-draft respawn uses the real legacy env alias', () => {
  const aliasNames = ENV_ALIASES['watcher.pending_draft_review_respawn_age_seconds']
    .aliases
    .map(([name]) => name);
  assert.ok(aliasNames.includes('ADVERSARIAL_REVIEW_PENDING_DRAFT_RESPAWN_AGE_SECONDS'));
  assert.ok(!aliasNames.includes('ADVERSARIAL_PENDING_DRAFT_RESPAWN_AGE_SECONDS'));
  assert.strictEqual(
    resolvePendingDraftRespawnAgeSeconds({
      ADVERSARIAL_REVIEW_SIGTERM_FENCE: 'on',
      ADVERSARIAL_REVIEW_PENDING_DRAFT_RESPAWN_AGE_SECONDS: '601',
    }),
    601
  );
});

test('promoted resolvers fail loud on canonical-vs-legacy env conflicts', () => {
  assertEnvAliasConflict(
    () => resolveReviewerTimeoutMs({
      AGENT_OS_REVIEWER_TIMEOUT_MS: '600000',
      ADVERSARIAL_REVIEWER_TIMEOUT_MS: '600001',
    }),
    ['AGENT_OS_REVIEWER_TIMEOUT_MS', 'ADVERSARIAL_REVIEWER_TIMEOUT_MS']
  );
  assertEnvAliasConflict(
    () => resolveProgressTimeoutMs({
      AGENT_OS_REVIEWER_NO_PROGRESS_TIMEOUT_MS: '300000',
      ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '300001',
    }),
    ['AGENT_OS_REVIEWER_NO_PROGRESS_TIMEOUT_MS', 'ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS']
  );
  assertEnvAliasConflict(
    () => resolveFirstPassReviewerPoolConfig({
      env: {
        AGENT_OS_WATCHER_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT_REVIEWERS: '4',
        ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT: '5',
      },
      watcherConfig: {},
    }),
    [
      'AGENT_OS_WATCHER_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT_REVIEWERS',
      'ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT',
    ]
  );
  assertEnvAliasConflict(
    () => resolveRemediationMaxConcurrentJobs({
      AGENT_OS_REMEDIATION_MAX_CONCURRENT_JOBS: '3',
      ADVERSARIAL_REMEDIATION_MAX_CONCURRENT_JOBS: '4',
    }),
    ['AGENT_OS_REMEDIATION_MAX_CONCURRENT_JOBS', 'ADVERSARIAL_REMEDIATION_MAX_CONCURRENT_JOBS']
  );
  assertEnvAliasConflict(
    () => normalizeMaxConcurrentFollowUpJobs(9, {
      env: {
        AGENT_OS_REMEDIATION_MAX_CONCURRENT_JOBS_CEILING: '4',
        ADVERSARIAL_REMEDIATION_MAX_CONCURRENT_JOBS_CEILING: '5',
      },
    }),
    [
      'AGENT_OS_REMEDIATION_MAX_CONCURRENT_JOBS_CEILING',
      'ADVERSARIAL_REMEDIATION_MAX_CONCURRENT_JOBS_CEILING',
    ]
  );
  assertEnvAliasConflict(
    () => loadConfig({
      env: {
        AGENT_OS_REMEDIATION_RECONCILIATION_MAX_ACTIVE_AGE_MS_BEFORE_ABANDON: '21600000',
        ADVERSARIAL_REMEDIATION_RECONCILIATION_MAX_ACTIVE_MS: '21600001',
      },
    }),
    [
      'AGENT_OS_REMEDIATION_RECONCILIATION_MAX_ACTIVE_AGE_MS_BEFORE_ABANDON',
      'ADVERSARIAL_REMEDIATION_RECONCILIATION_MAX_ACTIVE_MS',
    ]
  );
  assertEnvAliasConflict(
    () => resolveWatcherDrainMaxMs({
      AGENT_OS_WATCHER_MAX_DRAIN_WAIT_MS: '3600000',
      ADVERSARIAL_WATCHER_DRAIN_MAX_MS: '3600001',
    }),
    ['AGENT_OS_WATCHER_MAX_DRAIN_WAIT_MS', 'ADVERSARIAL_WATCHER_DRAIN_MAX_MS']
  );
  assertEnvAliasConflict(
    () => resolvePendingDraftRespawnAgeSeconds({
      AGENT_OS_WATCHER_PENDING_DRAFT_REVIEW_RESPAWN_AGE_SECONDS: '600',
      ADVERSARIAL_REVIEW_PENDING_DRAFT_RESPAWN_AGE_SECONDS: '601',
    }),
    [
      'AGENT_OS_WATCHER_PENDING_DRAFT_REVIEW_RESPAWN_AGE_SECONDS',
      'ADVERSARIAL_REVIEW_PENDING_DRAFT_RESPAWN_AGE_SECONDS',
    ]
  );
  assertEnvAliasConflict(
    () => resolveStuckDispatchAlertDebounceMs({
      AGENT_OS_WATCHER_STUCK_DISPATCH_ALERT_DEBOUNCE_MS: '3600000',
      ADVERSARIAL_STUCK_DISPATCH_ALERT_DEBOUNCE_MS: '3600001',
    }),
    ['AGENT_OS_WATCHER_STUCK_DISPATCH_ALERT_DEBOUNCE_MS', 'ADVERSARIAL_STUCK_DISPATCH_ALERT_DEBOUNCE_MS']
  );
  assertEnvAliasConflict(
    () => resolveHqWorkerTearDownTimeoutMs({
      AGENT_OS_FOLLOW_UP_HQ_WORKER_TEAR_DOWN_SUBPROCESS_TIMEOUT_MS: '60000',
      HQ_WORKER_TEAR_DOWN_TIMEOUT_MS: '60001',
    }),
    ['AGENT_OS_FOLLOW_UP_HQ_WORKER_TEAR_DOWN_SUBPROCESS_TIMEOUT_MS', 'HQ_WORKER_TEAR_DOWN_TIMEOUT_MS']
  );
  assertEnvAliasConflict(
    () => resolveHqDispatchTimeoutMs({
      AGENT_OS_FOLLOW_UP_HQ_DISPATCH_SUBPROCESS_TIMEOUT_MS: '90000',
      HQ_DISPATCH_TIMEOUT_MS: '90001',
    }),
    ['AGENT_OS_FOLLOW_UP_HQ_DISPATCH_SUBPROCESS_TIMEOUT_MS', 'HQ_DISPATCH_TIMEOUT_MS']
  );
});

test('schema defaults resolve to documented values when nothing is overridden', () => {
  // Strip every env var that could shadow these knobs before loading.
  const scrubbedEnv = { ...process.env };
  for (const aliasInfo of Object.values(ENV_ALIASES)) {
    delete scrubbedEnv[aliasInfo.canonical];
    for (const [alias] of (aliasInfo.aliases || [])) {
      delete scrubbedEnv[alias];
    }
  }
  scrubbedEnv.AGENT_OS_CONFIG_PATH = '/dev/null';

  const cfg = loadConfig({ env: scrubbedEnv });
  const expected = {
    'remediation.max_concurrent_jobs': 1,
    'remediation.max_concurrent_jobs_ceiling': 8,
    'remediation.reconciliation_max_active_age_ms_before_abandon': 21_600_000,
    'reviewer.timeout_ms': 1_200_000,
    'reviewer.no_progress_timeout_ms': 900_000,
    'watcher.max_drain_wait_ms': 3_600_000,
    'watcher.pending_draft_review_respawn_age_seconds': 900,
    'watcher.stuck_dispatch_alert_debounce_ms': 3_600_000,
    'watcher.first_pass_reviewer_pool_max_concurrent_reviewers': 6,
    'follow_up.hq_worker_tear_down_subprocess_timeout_ms': 60_000,
    'follow_up.hq_dispatch_subprocess_timeout_ms': 90_000,
  };
  for (const [k, want] of Object.entries(expected)) {
    assert.strictEqual(cfg.get(k, 'UNSET-SENTINEL'), want, `${k}: got ${JSON.stringify(cfg.get(k))}, want ${want}`);
  }
});

test('reviewer.timeout_ms: legacy ADVERSARIAL_REVIEWER_TIMEOUT_MS env still wins', () => {
  const env = { ADVERSARIAL_REVIEWER_TIMEOUT_MS: '600000' };
  assert.strictEqual(resolveReviewerTimeoutMs(env), 600_000);
});

test('reviewer.no_progress_timeout_ms: legacy ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS env still wins', () => {
  const env = { ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '300000' };
  assert.strictEqual(resolveProgressTimeoutMs(env), 300_000);
});

test('reviewer.timeout_ms: defaults applied when env is absent', () => {
  const env = {};
  // Defaults to the hardcoded constant (CFG won't be loaded for an empty env path);
  // the constant must be 20 * 60 * 1000.
  assert.strictEqual(resolveReviewerTimeoutMs(env), 20 * 60 * 1000);
});

test('reviewer timeout helpers honor canonical env keys and env-scoped AGENT_OS_CONFIG_PATH', () => {
  const { configPath, cleanup } = createTempConfig(`version: 1
reviewer:
  timeout_ms: 345000
  no_progress_timeout_ms: 234000
`);
  try {
    const env = {
      AGENT_OS_CONFIG_PATH: configPath,
    };
    assert.strictEqual(resolveReviewerTimeoutMs(env), 345_000);
    assert.strictEqual(resolveProgressTimeoutMs(env), 234_000);
  } finally {
    cleanup();
  }
});

test('reviewer timeout helpers honor module-local config cascade', () => {
  const { configPath: moduleConfigPath, cleanup } = createTempConfig(`reviewer:
  timeout_ms: 345000
  no_progress_timeout_ms: 234000
`);
  try {
    assert.strictEqual(
      resolveReviewerTimeoutMs({}, { topPath: '/dev/null', modulePaths: [moduleConfigPath] }),
      345_000
    );
    assert.strictEqual(
      resolveProgressTimeoutMs({}, { topPath: '/dev/null', modulePaths: [moduleConfigPath] }),
      234_000
    );
  } finally {
    cleanup();
  }
});

test('reviewer timeout helpers honor canonical AGENT_OS_* env overrides from the supplied env', () => {
  const env = {
    AGENT_OS_REVIEWER_TIMEOUT_MS: '456000',
    AGENT_OS_REVIEWER_NO_PROGRESS_TIMEOUT_MS: '123000',
  };
  assert.strictEqual(resolveReviewerTimeoutMs(env), 456_000);
  assert.strictEqual(resolveProgressTimeoutMs(env), 123_000);
});

test('reviewer timeout helpers fail loud on canonical env parse errors', () => {
  assert.throws(
    () => resolveReviewerTimeoutMs({ AGENT_OS_REVIEWER_TIMEOUT_MS: 'banana' }),
    AgentOSConfigError
  );
});

test('first-pass reviewer pool: legacy ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT env still wins', () => {
  const env = { ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT: '7' };
  const cfg = resolveFirstPassReviewerPoolConfig({ env, watcherConfig: {} });
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(cfg.maxConcurrent, 7);
});

test('first-pass reviewer pool: defaults to durable CFG value when env is unset', () => {
  const env = {};
  const cfg = resolveFirstPassReviewerPoolConfig({
    env,
    watcherConfig: {},
    topPath: '/dev/null',
  });
  assert.strictEqual(cfg.maxConcurrent, 6);
});

test('first-pass reviewer pool honors canonical env-scoped config path', () => {
  const { configPath, cleanup } = createTempConfig(`version: 1
watcher:
  first_pass_reviewer_pool_max_concurrent_reviewers: 5
`);
  try {
    const cfg = resolveFirstPassReviewerPoolConfig({
      env: { AGENT_OS_CONFIG_PATH: configPath },
      watcherConfig: {},
    });
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.maxConcurrent, 5);
  } finally {
    cleanup();
  }
});

test('first-pass reviewer pool honors module-local config cascade', () => {
  const { configPath: moduleConfigPath, cleanup } = createTempConfig(`watcher:
  first_pass_reviewer_pool_max_concurrent_reviewers: 5
`);
  try {
    const cfg = resolveFirstPassReviewerPoolConfig({
      env: {},
      watcherConfig: {},
      topPath: '/dev/null',
      modulePaths: [moduleConfigPath],
    });
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.maxConcurrent, 5);
  } finally {
    cleanup();
  }
});

test('first-pass reviewer pool honors canonical AGENT_OS_* env overrides from the supplied env', () => {
  const cfg = resolveFirstPassReviewerPoolConfig({
    env: { AGENT_OS_WATCHER_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT_REVIEWERS: '8' },
    watcherConfig: {},
  });
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(cfg.maxConcurrent, 8);
});

test('first-pass reviewer pool clamps over-large canonical AGENT_OS_* env overrides', () => {
  const cfg = resolveFirstPassReviewerPoolConfig({
    env: { AGENT_OS_WATCHER_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT_REVIEWERS: '99' },
    watcherConfig: {},
  });
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(cfg.maxConcurrent, 12);
});

test('first-pass reviewer pool fails loud on canonical env parse errors', () => {
  assert.throws(
    () => resolveFirstPassReviewerPoolConfig({
      env: { AGENT_OS_WATCHER_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT_REVIEWERS: 'banana' },
      watcherConfig: {},
    }),
    AgentOSConfigError
  );
});

test('normalizeMaxConcurrentFollowUpJobs: clamps to CFG-resolved ceiling', () => {
  // Default ceiling from CFG should be 8 (matches MAX_REMEDIATION_MAX_CONCURRENT_JOBS).
  // Pass a value above the ceiling and expect it to be clamped to 8.
  const clamped = normalizeMaxConcurrentFollowUpJobs(15);
  assert.strictEqual(clamped, 8);
});

test('normalizeMaxConcurrentFollowUpJobs: respects explicit options.max override', () => {
  // Tests can short-circuit the CFG lookup via options.max — important for
  // unit tests that don't want to stand up the full config loader.
  const clamped = normalizeMaxConcurrentFollowUpJobs(15, { max: 4 });
  assert.strictEqual(clamped, 4);
});

test('normalizeMaxConcurrentFollowUpJobs: returns fallback for non-positive input', () => {
  assert.strictEqual(normalizeMaxConcurrentFollowUpJobs(0), 1);
  assert.strictEqual(normalizeMaxConcurrentFollowUpJobs(-5), 1);
  assert.strictEqual(normalizeMaxConcurrentFollowUpJobs('banana'), 1);
});

test('remediation concurrency honors canonical env-scoped config path for floor and ceiling', () => {
  const { configPath, cleanup } = createTempConfig(`version: 1
remediation:
  max_concurrent_jobs: 4
  max_concurrent_jobs_ceiling: 5
`);
  try {
    const env = {
      AGENT_OS_CONFIG_PATH: configPath,
    };
    assert.strictEqual(resolveRemediationMaxConcurrentJobs(env), 4);
    assert.strictEqual(normalizeMaxConcurrentFollowUpJobs(9, { env }), 5);
  } finally {
    cleanup();
  }
});

test('remediation concurrency honors module-local config cascade for floor and ceiling', () => {
  const { configPath: moduleConfigPath, cleanup } = createTempConfig(`remediation:
  max_concurrent_jobs: 4
  max_concurrent_jobs_ceiling: 5
`);
  try {
    assert.strictEqual(
      resolveRemediationMaxConcurrentJobs({}, { topPath: '/dev/null', modulePaths: [moduleConfigPath] }),
      4
    );
    assert.strictEqual(
      normalizeMaxConcurrentFollowUpJobs(9, { env: {}, topPath: '/dev/null', modulePaths: [moduleConfigPath] }),
      5
    );
  } finally {
    cleanup();
  }
});

test('remediation concurrency honors canonical AGENT_OS_* env overrides from the supplied env', () => {
  const env = {
    AGENT_OS_REMEDIATION_MAX_CONCURRENT_JOBS: '3',
    AGENT_OS_REMEDIATION_MAX_CONCURRENT_JOBS_CEILING: '4',
  };
  assert.strictEqual(resolveRemediationMaxConcurrentJobs(env), 3);
  assert.strictEqual(normalizeMaxConcurrentFollowUpJobs(9, { env }), 4);
});

test('remediation concurrency fails loud on canonical env parse errors', () => {
  assert.throws(
    () => resolveRemediationMaxConcurrentJobs({ AGENT_OS_REMEDIATION_MAX_CONCURRENT_JOBS: 'banana' }),
    AgentOSConfigError
  );
});

test('watcher and follow-up runtime resolvers honor promoted module-local CFG knobs', () => {
  const { configPath: moduleConfigPath, cleanup } = createTempConfig(`watcher:
  max_drain_wait_ms: 120000
  pending_draft_review_respawn_age_seconds: 601
  stuck_dispatch_alert_debounce_ms: 240000
follow_up:
  hq_worker_tear_down_subprocess_timeout_ms: 45000
  hq_dispatch_subprocess_timeout_ms: 135000
`);
  try {
    const options = { topPath: '/dev/null', modulePaths: [moduleConfigPath] };
    assert.strictEqual(resolveWatcherDrainMaxMs({}, options), 120_000);
    assert.strictEqual(resolvePendingDraftRespawnAgeSeconds({}, options), 601);
    assert.strictEqual(resolveStuckDispatchAlertDebounceMs({}, options), 240_000);
    assert.strictEqual(resolveHqWorkerTearDownTimeoutMs({}, options), 45_000);
    assert.strictEqual(resolveHqDispatchTimeoutMs({}, options), 135_000);
  } finally {
    cleanup();
  }
});
