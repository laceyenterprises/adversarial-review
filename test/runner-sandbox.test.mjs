import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ABANDONED_SANDBOX_MIN_AGE_MS, reclaimAbandonedSandboxes, SANDBOX_OWNER_MARKER } from './helpers/runner-sandbox.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));

function fixtureRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-cleanup-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 5_000 });
  assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  return child.pid;
}

function sandbox(base, name, pid, age = ABANDONED_SANDBOX_MIN_AGE_MS * 2) {
  const root = path.join(base, name);
  mkdirSync(root);
  if (pid !== undefined) {
    writeFileSync(path.join(root, SANDBOX_OWNER_MARKER), JSON.stringify({ version: 1, pid }));
    const time = new Date(Date.now() - age);
    utimesSync(path.join(root, SANDBOX_OWNER_MARKER), time, time);
  }
  const time = new Date(Date.now() - age);
  utimesSync(root, time, time);
  return root;
}

test('startup reclaims only old, same-user sandboxes with confirmed dead owners', { skip: !process.getuid }, (t) => {
  const base = fixtureRoot(t);
  const pid = deadPid();
  const stale = sandbox(base, 'art-stale', pid);
  const live = sandbox(base, 'art-live', process.pid);
  const young = sandbox(base, 'art-young', pid, 0);
  const unknown = sandbox(base, 'art-unknown', undefined, 0);
  const legacy = sandbox(base, 'art-legacy', undefined);
  const unrelated = sandbox(base, 'other-stale', pid);
  assert.equal(reclaimAbandonedSandboxes(base), 1);
  assert.equal(existsSync(stale), false);
  for (const root of [live, young, unknown, legacy, unrelated]) assert.equal(existsSync(root), true);
  assert.equal(reclaimAbandonedSandboxes(base), 0, 'reclamation must be idempotent');
});

test('uncertain ownership, fresh metadata and symlinks never authorize reclamation', { skip: !process.getuid }, (t) => {
  const base = fixtureRoot(t);
  const pid = deadPid();
  const stale = sandbox(base, 'art-stale', pid);
  assert.equal(reclaimAbandonedSandboxes(base, { uid: process.getuid() + 1 }), 0);
  for (const code of ['EPERM', 'EINVAL']) {
    assert.equal(reclaimAbandonedSandboxes(base, {
      kill() { throw Object.assign(new Error('synthetic probe failure'), { code }); },
    }), 0);
  }
  assert.equal(existsSync(stale), true);
  rmSync(stale, { recursive: true });

  for (const [index, owner] of [null, {}, { version: 2, pid }, { version: 1, pid: -1 },
    { version: 1, pid: 0 }, { version: 1, pid: '123' }].entries()) {
    const root = sandbox(base, `art-invalid-${index}`, pid);
    writeFileSync(path.join(root, SANDBOX_OWNER_MARKER), JSON.stringify(owner));
    const time = new Date(Date.now() - ABANDONED_SANDBOX_MIN_AGE_MS * 2);
    utimesSync(path.join(root, SANDBOX_OWNER_MARKER), time, time);
  }
  const malformed = sandbox(base, 'art-malformed', pid);
  writeFileSync(path.join(malformed, SANDBOX_OWNER_MARKER), '{');
  const old = new Date(Date.now() - ABANDONED_SANDBOX_MIN_AGE_MS * 2);
  utimesSync(path.join(malformed, SANDBOX_OWNER_MARKER), old, old);
  const freshMarker = sandbox(base, 'art-fresh-marker', pid);
  utimesSync(path.join(freshMarker, SANDBOX_OWNER_MARKER), new Date(), new Date());
  const freshDirectory = sandbox(base, 'art-fresh-directory', pid);
  utimesSync(freshDirectory, new Date(), new Date());
  const target = sandbox(base, 'unrelated-target', pid);
  symlinkSync(target, path.join(base, 'art-link'), 'dir');
  const linkedMarker = sandbox(base, 'art-linked-marker', undefined);
  symlinkSync(path.join(target, SANDBOX_OWNER_MARKER), path.join(linkedMarker, SANDBOX_OWNER_MARKER));
  utimesSync(linkedMarker, old, old);
  writeFileSync(path.join(base, 'art-file'), 'synthetic fixture');
  const before = readdirSync(base).sort();
  assert.equal(reclaimAbandonedSandboxes(base), 0);
  assert.deepEqual(readdirSync(base).sort(), before);
  assert.equal(existsSync(target), true);
});

async function waitFor(predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for fixture state');
    await delay(20);
  }
}

async function startRunner(t, mode) {
  const base = mkdtempSync(path.join(tmpdir(), 'runner-cleanup-fixture-'));
  const ready = path.join(base, 'ready.json');
  const exitRequest = path.join(base, 'exit-request');
  const args = [];
  if (mode) {
    const hook = path.join(base, 'exit-hook.mjs');
    writeFileSync(hook, `
      import { existsSync } from 'node:fs';
      const timer = setInterval(() => {
        if (!existsSync(${JSON.stringify(exitRequest)})) return;
        clearInterval(timer);
        ${mode === 'exit' ? 'process.exit(23);' : "throw new Error('synthetic runner failure');"}
      }, 20);
    `);
    args.push('--import', hook);
  }
  const env = {
    ...process.env,
    ADVERSARIAL_REVIEW_TEST_TEMP_BASE: base,
    HQ_ROOT_FIXTURE_HOLD: ready,
    HQ_ROOT_FIXTURE_FAIL: '0',
  };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [...args, path.join(testDir, 'run-tests.mjs'), 'hq-root-runner-probe.test.mjs'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  t.after(async () => {
    const force = setTimeout(() => child.kill('SIGKILL'), 7_000);
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
    } finally {
      clearTimeout(force);
      rmSync(base, { recursive: true, force: true });
    }
  });
  await waitFor(() => {
    assert.ok(child.exitCode === null && child.signalCode === null, output);
    return existsSync(ready);
  });
  const root = path.join(base, readdirSync(base).find((name) => name.startsWith('art-')));
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, SANDBOX_OWNER_MARKER), 'utf8')), {
    version: 1, pid: child.pid,
  });
  return { root, ready, exitRequest, child, closed, output: () => output };
}

test('runner startup logs reclamation and removes its own sandbox on normal completion', {
  skip: !process.getuid, timeout: 20_000,
}, (t) => {
  const base = fixtureRoot(t);
  const stale = sandbox(base, 'art-stale', deadPid());
  const live = sandbox(base, 'art-live', process.pid);
  const unknown = sandbox(base, 'art-unknown', undefined, 0);
  const env = { ...process.env, ADVERSARIAL_REVIEW_TEST_TEMP_BASE: base, HQ_ROOT_FIXTURE_FAIL: '0' };
  delete env.NODE_TEST_CONTEXT;
  delete env.HQ_ROOT_FIXTURE_HOLD;
  const child = spawnSync(process.execPath, [path.join(testDir, 'run-tests.mjs'), 'hq-root-runner-probe.test.mjs'], {
    env, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.match(child.stderr, /reclaimed 1 abandoned sandbox/);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(unknown), true);
  assert.deepEqual(readdirSync(base).sort(), ['art-live', 'art-unknown']);
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  test(`runner removes its sandbox after ${signal} terminates the child`, {
    skip: process.platform === 'win32', timeout: 20_000,
  }, async (t) => {
    const { root, ready, child, closed, output } = await startRunner(t);
    const worker = JSON.parse(readFileSync(ready, 'utf8'));
    child.kill(signal);
    assert.deepEqual(await closed, { status: 128 + constants.signals[signal], signal: null }, output());
    assert.equal(existsSync(root), false);
    await waitFor(() => {
      try { process.kill(worker.pid, 0); return false; } catch (error) {
        assert.equal(error.code, 'ESRCH');
        return true;
      }
    });
  });
}

for (const mode of ['exit', 'exception']) {
  test(`runner exit hook cleans up on an explicit ${mode}`, {
    skip: process.platform === 'win32', timeout: 20_000,
  }, async (t) => {
    const { root, ready, exitRequest, closed } = await startRunner(t, mode);
    const worker = JSON.parse(readFileSync(ready, 'utf8'));
    writeFileSync(exitRequest, 'exit');
    assert.equal((await closed).status, mode === 'exit' ? 23 : 1);
    assert.equal(existsSync(root), false);
    await waitFor(() => {
      try { process.kill(worker.pid, 0); return false; } catch (error) {
        assert.equal(error.code, 'ESRCH');
        return true;
      }
    });
  });
}
