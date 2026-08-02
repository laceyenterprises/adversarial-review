import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  DAEMON_SINGLETON_HELD_CODE,
  DAEMON_SINGLETON_OWNER_MISMATCH_CODE,
  acquireDaemonSingleton,
  assertDaemonSingletonOwnerCompatible,
  readDaemonSingletonHolder,
  resolveDaemonSingletonLockPath,
} from '../src/daemon-singleton.mjs';

function makeRootDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function waitForStdout(proc, pattern) {
  let output = '';
  proc.stdout.setEncoding('utf8');
  for await (const chunk of proc.stdout) {
    output += chunk;
    if (pattern.test(output)) return output;
  }
  throw new Error(`process exited before stdout matched ${pattern}: ${output}`);
}

test('acquireDaemonSingleton writes a holder record and releases cleanly', () => {
  const rootDir = makeRootDir('daemon-singleton-');
  const stateDir = join(rootDir, 'state');
  try {
    const singleton = acquireDaemonSingleton({
      rootDir,
      daemonName: 'watcher',
      env: { ADVERSARIAL_REVIEW_STATE_DIR: stateDir },
      argv: ['node', 'watcher.mjs'],
      startedAt: '2026-08-01T00:00:00.000Z',
      logger: { log() {} },
    });
    const holder = readDaemonSingletonHolder(singleton.lockPath);
    assert.equal(holder.daemonName, 'watcher');
    assert.equal(holder.pid, process.pid);
    assert.equal(holder.command, 'node watcher.mjs');
    singleton.release();

    const reacquired = acquireDaemonSingleton({
      rootDir,
      daemonName: 'watcher',
      env: { ADVERSARIAL_REVIEW_STATE_DIR: stateDir },
      logger: { log() {} },
    });
    reacquired.release();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('acquireDaemonSingleton rejects a second process for the same daemon', async () => {
  const rootDir = makeRootDir('daemon-singleton-cross-process-');
  const stateDir = join(rootDir, 'state');
  const helperUrl = pathToFileURL(join(process.cwd(), 'src', 'daemon-singleton.mjs')).href;
  const childCode = `
    import { acquireDaemonSingleton } from ${JSON.stringify(helperUrl)};
    const singleton = acquireDaemonSingleton({
      rootDir: ${JSON.stringify(rootDir)},
      daemonName: 'follow-up',
      env: { ADVERSARIAL_REVIEW_STATE_DIR: ${JSON.stringify(stateDir)} },
      argv: ['node', 'follow-up'],
      startedAt: '2026-08-01T00:00:01.000Z',
      logger: { log() {} },
    });
    console.log('singleton-ready');
    process.on('SIGTERM', () => { singleton.release(); process.exit(0); });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await waitForStdout(child, /singleton-ready/);
    const lockPath = resolveDaemonSingletonLockPath({
      rootDir,
      daemonName: 'follow-up',
      env: { ADVERSARIAL_REVIEW_STATE_DIR: stateDir },
    });
    assert.throws(
      () => acquireDaemonSingleton({
        rootDir,
        daemonName: 'follow-up',
        env: { ADVERSARIAL_REVIEW_STATE_DIR: stateDir },
        logger: { log() {} },
      }),
      (err) => {
        assert.equal(err.code, DAEMON_SINGLETON_HELD_CODE);
        assert.equal(err.lockPath, lockPath);
        assert.equal(err.holder.daemonName, 'follow-up');
        assert.equal(err.holder.command, 'node follow-up');
        return true;
      }
    );
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
    rmSync(rootDir, { recursive: true, force: true });
  }
  assert.equal(stderr, '');
});

test('assertDaemonSingletonOwnerCompatible rejects cross-user state writes', () => {
  assert.throws(
    () => assertDaemonSingletonOwnerCompatible('/state/daemon-singletons', {
      getUidImpl: () => 501,
      existsSyncImpl: (path) => path === '/state',
      statSyncImpl: (path) => {
        assert.equal(path, '/state');
        return { uid: 502 };
      },
    }),
    (err) => {
      assert.equal(err.code, DAEMON_SINGLETON_OWNER_MISMATCH_CODE);
      assert.equal(err.path, '/state/daemon-singletons');
      assert.equal(err.ownerPath, '/state');
      assert.equal(err.ownerUid, 502);
      assert.equal(err.processUid, 501);
      return true;
    }
  );
});
