import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fireDagAutowalkOnMerge,
  retryPendingDagAutowalkOnMerge,
} from '../src/watcher.mjs';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'watcher-autowalk-on-merge-'));
}

function cleanupRoot(rootDir) {
  rmSync(rootDir, { recursive: true, force: true });
}

function recordDir(rootDir) {
  return join(rootDir, 'data', 'follow-up-jobs', 'dag-autowalk-on-merge');
}

function readOnlyRecord(rootDir) {
  const files = readdirSync(recordDir(rootDir));
  assert.equal(files.length, 1);
  return {
    path: join(recordDir(rootDir), files[0]),
    record: JSON.parse(readFileSync(join(recordDir(rootDir), files[0]), 'utf8')),
  };
}

function makeLogger() {
  const logs = [];
  const errors = [];
  return {
    logs,
    errors,
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
  };
}

const HERMETIC_CONFIG_ENV = { AGENT_OS_CONFIG_PATH: '/dev/null' };

test('fireDagAutowalkOnMerge persists owed work before the command attempt', (t) => {
  const rootDir = makeRoot();
  t.after(() => cleanupRoot(rootDir));
  const logger = makeLogger();

  fireDagAutowalkOnMerge({
    rootDir,
    repo: 'acme/agent-os',
    prNumber: 42,
    logger,
    now: new Date('2026-06-14T10:00:00.000Z'),
  });

  const { record } = readOnlyRecord(rootDir);
  assert.equal(record.repo, 'acme/agent-os');
  assert.equal(record.prNumber, 42);
  assert.equal(record.status, 'pending');
  assert.equal(record.attempts, 0);
  assert.equal(record.createdAt, '2026-06-14T10:00:00.000Z');
  assert.ok(logger.logs.some((m) => m.includes('autowalk-on-merge owed for acme/agent-os#42')));
});

test('retryPendingDagAutowalkOnMerge runs hq and clears the owed record only on success', async (t) => {
  const rootDir = makeRoot();
  t.after(() => cleanupRoot(rootDir));
  const calls = [];
  const execFileImpl = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { stdout: 'walked\n', stderr: '' };
  };

  fireDagAutowalkOnMerge({ rootDir, repo: 'acme/agent-os', prNumber: 42, logger: makeLogger() });
  const before = readOnlyRecord(rootDir);
  const result = await retryPendingDagAutowalkOnMerge({
    rootDir,
    execFileImpl,
    env: HERMETIC_CONFIG_ENV,
    logger: makeLogger(),
    maxPerPoll: 1,
  });

  assert.deepEqual(result, { attempted: 1, skipped: 0, pending: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.env.HQ_BIN || 'hq');
  assert.deepEqual(calls[0].args, [
    'dag', 'autowalk-on-merge', '--repo', 'acme/agent-os', '--pr', '42',
  ]);
  assert.equal(calls[0].opts.stdio, undefined);
  assert.equal(existsSync(before.path), false);
});

test('retryPendingDagAutowalkOnMerge passes config-resolved repo root from distinct watcher cwd', async (t) => {
  const rootDir = makeRoot();
  t.after(() => cleanupRoot(rootDir));
  const deployRoot = join(rootDir, 'installed-agent-os');
  const watcherCwd = join(rootDir, 'watcher-checkout');
  mkdirSync(deployRoot, { recursive: true });
  mkdirSync(watcherCwd, { recursive: true });
  const originalCwd = process.cwd();
  const calls = [];
  const execFileImpl = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts, cwd: process.cwd() });
    return { stdout: 'walked\n', stderr: '' };
  };
  const loadConfigImpl = () => ({
    get(key) {
      return key === 'roots.deploy' ? deployRoot : null;
    },
  });

  fireDagAutowalkOnMerge({ rootDir, repo: 'laceyenterprises/agent-os', prNumber: 3565, logger: makeLogger() });
  try {
    process.chdir(watcherCwd);
    await retryPendingDagAutowalkOnMerge({
      rootDir,
      execFileImpl,
      env: HERMETIC_CONFIG_ENV,
      loadConfigImpl,
      logger: makeLogger(),
      maxPerPoll: 1,
    });
  } finally {
    process.chdir(originalCwd);
  }

  assert.equal(calls.length, 1);
  assert.match(calls[0].cwd, /watcher-checkout$/);
  assert.notEqual(calls[0].cwd, deployRoot);
  assert.deepEqual(calls[0].args, [
    'dag', 'autowalk-on-merge',
    '--repo-root', deployRoot,
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '3565',
  ]);
});

test('retryPendingDagAutowalkOnMerge captures nonzero output and retries later after merged state', async (t) => {
  const rootDir = makeRoot();
  t.after(() => cleanupRoot(rootDir));
  const logger = makeLogger();
  let calls = 0;
  const execFileImpl = async () => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('Command failed: hq dag autowalk-on-merge');
      err.exitCode = 17;
      err.stdout = 'stdout details\n';
      err.stderr = 'sqlite busy\n';
      throw err;
    }
    return { stdout: 'recovered\n', stderr: '' };
  };

  fireDagAutowalkOnMerge({ rootDir, repo: 'acme/agent-os', prNumber: 42, logger });
  await retryPendingDagAutowalkOnMerge({
    rootDir,
    execFileImpl,
    env: HERMETIC_CONFIG_ENV,
    logger,
    retryMs: 0,
    maxAttempts: 2,
  });

  const failed = readOnlyRecord(rootDir);
  assert.equal(failed.record.status, 'pending');
  assert.equal(failed.record.attempts, 1);
  assert.equal(failed.record.lastError.exitCode, 17);
  assert.equal(failed.record.lastError.stdout, 'stdout details\n');
  assert.equal(failed.record.lastError.stderr, 'sqlite busy\n');

  await retryPendingDagAutowalkOnMerge({
    rootDir,
    execFileImpl,
    env: HERMETIC_CONFIG_ENV,
    logger,
    retryMs: 0,
    maxAttempts: 2,
  });

  assert.equal(calls, 2);
  assert.equal(existsSync(failed.path), false);
});

test('retryPendingDagAutowalkOnMerge keeps terminal diagnostics after max attempts', async (t) => {
  const rootDir = makeRoot();
  t.after(() => cleanupRoot(rootDir));
  const execFileImpl = async () => {
    const err = new Error('missing hq');
    err.code = 'ENOENT';
    err.stderr = 'not found\n';
    throw err;
  };

  fireDagAutowalkOnMerge({ rootDir, repo: 'acme/agent-os', prNumber: 7, logger: makeLogger() });
  await retryPendingDagAutowalkOnMerge({
    rootDir,
    execFileImpl,
    env: HERMETIC_CONFIG_ENV,
    logger: makeLogger(),
    retryMs: 0,
    maxAttempts: 1,
  });

  const { record } = readOnlyRecord(rootDir);
  assert.equal(record.status, 'failed');
  assert.equal(record.attempts, 1);
  assert.equal(record.lastError.code, 'ENOENT');
  assert.equal(record.lastError.stderr, 'not found\n');
});

test('retryPendingDagAutowalkOnMerge marks malformed records failed without consuming retry budget', async (t) => {
  const rootDir = makeRoot();
  t.after(() => cleanupRoot(rootDir));
  const logger = makeLogger();
  const calls = [];
  const execFileImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: 'walked\n', stderr: '' };
  };

  fireDagAutowalkOnMerge({
    rootDir,
    repo: 'acme/agent-os',
    prNumber: 42,
    logger,
    now: new Date('2026-06-14T10:01:00.000Z'),
  });
  writeFileSync(
    join(recordDir(rootDir), '000-malformed.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      status: 'pending',
      createdAt: '2026-06-14T10:00:00.000Z',
      updatedAt: '2026-06-14T10:00:00.000Z',
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    }, null, 2)}\n`
  );

  const result = await retryPendingDagAutowalkOnMerge({
    rootDir,
    execFileImpl,
    env: HERMETIC_CONFIG_ENV,
    logger,
    maxPerPoll: 1,
    maxAttempts: 3,
  });

  assert.deepEqual(result, { attempted: 1, skipped: 1, pending: 2 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'dag', 'autowalk-on-merge', '--repo', 'acme/agent-os', '--pr', '42',
  ]);
  const { record } = readOnlyRecord(rootDir);
  assert.equal(record.status, 'failed');
  assert.equal(record.attempts, 3);
  assert.equal(record.lastError.code, 'malformed-record');
  assert.ok(logger.errors.some((m) => m.includes('malformed owed record marked failed')));
});

test('pollOnce keeps dag autowalk-on-merge retry as a single poll-level pass', () => {
  const source = readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8');
  const lifecycleStart = source.indexOf('async function syncPRLifecycle(');
  const pollStart = source.indexOf('async function pollOnce(');
  assert.notEqual(lifecycleStart, -1);
  assert.notEqual(pollStart, -1);

  const lifecycleSource = source.slice(lifecycleStart, pollStart);
  assert.equal(
    lifecycleSource.includes('await retryPendingDagAutowalkOnMerge('),
    false,
    'syncPRLifecycle must enqueue owed work without running the global retry worker per merged PR'
  );

  const pollSource = source.slice(pollStart, source.indexOf('async function main(', pollStart));
  assert.ok(
    pollSource.includes('await runQueuedReviewAdoptionPhase({'),
    'pollOnce should delegate the queued post-review phase once per tick'
  );

  const phaseStart = source.indexOf('async function runQueuedReviewAdoptionPhase(');
  const phaseSource = source.slice(
    phaseStart,
    source.indexOf('async function maybeDispatchReviewerTimeoutExhaustedMergeAgent(', phaseStart),
  );
  const syncIndex = phaseSource.indexOf('await syncPRLifecycleImpl(octokit, operatorSurface);');
  const retryIndex = phaseSource.indexOf('await retryPendingDagAutowalkOnMergeImpl();');
  assert.ok(syncIndex >= 0);
  assert.ok(retryIndex > syncIndex, 'pollOnce phase should retry once after lifecycle sync sees new merges');
  assert.equal(
    phaseSource.match(/await retryPendingDagAutowalkOnMergeImpl\(\);/g)?.length,
    1,
    'pollOnce phase should run the dag autowalk-on-merge retry worker once per tick'
  );
});
