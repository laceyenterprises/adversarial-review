import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
