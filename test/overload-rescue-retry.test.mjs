import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opendir } from 'node:fs/promises';
import { createOverloadRescueRetry } from '../src/overload-rescue-retry.mjs';
import { deferOverload } from '../src/overload-deferral.mjs';

const enabledConfig = () => ({ enabled: true, autonomousMergeExecutionEnabled: true });

const evidence = { phase: 'rescue-dispatch', deadline_seconds: 30,
  scaled_budget_seconds: 180, load_multiplier: 6, load_per_core: 4 };

function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'overload-rescue-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const directory = join(rootDir, 'data/follow-up-jobs/merge-agent-dispatches');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'synthetic-pr-7-old-round-1.json');
  const record = { repo: 'example/project', prNumber: 7, headSha: 'old',
    pendingHandoff: true, launchRequestId: null, dispatchArgs: ['never-execute-receipt'],
    overloadDeferral: deferOverload('synthetic-key', evidence, null, 1000) };
  const write = () => writeFileSync(path, JSON.stringify(record));
  write();
  return { rootDir, record, path, write };
}

test('watcher owns due rescue debt after restart and submits only fresh PR identity', async t => {
  const { rootDir } = fixture(t);
  let now = 1029_000;
  const calls = [];
  const options = { rootDir, env: { HQ_ROOT: rootDir, HQ_BIN: 'synthetic-hq' },
    now: () => now, execute: async (...args) => { calls.push(args); } };
  await createOverloadRescueRetry({ ...options, readConfig: enabledConfig }).tick();
  assert.equal(calls.length, 0);
  now = 1030_000;
  // A newly constructed watcher recovers disk debt without an in-memory timer.
  await createOverloadRescueRetry({ ...options, readConfig: enabledConfig }).tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'synthetic-hq');
  assert.deepEqual(calls[0][1], ['merge-agent', 'rescue', '7', '--repo', 'example/project',
    '--hq-root', rootDir, '--apply', '--json', '--retry-overload-only']);
  assert.equal(calls[0][2].timeout, 600_000);
  assert.equal(calls[0][2].reapGroupOnExit, true);
});

test('continued load advances durable debt; cap release and alert happen once', async t => {
  const { rootDir, record, path, write } = fixture(t);
  let now = 1030_000;
  let alerts = 0;
  let calls = 0;
  const driver = createOverloadRescueRetry({ rootDir, readConfig: enabledConfig, now: () => now, env: { HQ_ROOT: rootDir },
    execute: async () => {
      calls++;
      // Synthetic rescue boundary. Python tests cover actual reconciliation,
      // counter advancement, outbox publication and custody release.
      record.overloadDeferral = deferOverload('synthetic-key', evidence, record.overloadDeferral, now / 1000);
      if (record.overloadDeferral.overloadAlert) {
        alerts++;
        record.pendingHandoff = false;
        record.lastOverloadDeferral = record.overloadDeferral;
        delete record.overloadDeferral;
      }
      write();
    } });
  for (let count = 2; count <= 5; count++) {
    await driver.tick();
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal((stored.overloadDeferral || stored.lastOverloadDeferral).deferralCount, count);
    now = (stored.overloadDeferral?.nextRetryAt || 9999) * 1000;
  }
  await driver.tick();
  assert.equal(calls, 4);
  assert.equal(alerts, 1);
  assert.equal(record.pendingHandoff, false);
});

test('legacy exhausted receipts are reconciled; concurrent ticks share one bounded child', { timeout: 5000 }, async t => {
  const { rootDir, record, write } = fixture(t);
  record.overloadDeferral = { ...record.overloadDeferral, overloadAlert: true, nextRetryAt: null };
  write();
  let finish;
  let started;
  const executing = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const driver = createOverloadRescueRetry({ rootDir, readConfig: enabledConfig, execute: () => {
    calls++;
    started();
    return new Promise(resolve => { finish = resolve; });
  } });
  const first = driver.tick();
  assert.equal(driver.tick(), first);
  await executing;
  assert.equal(calls, 1);
  finish();
  await first;
});

test('one unavailable PR does not starve another due receipt', async t => {
  const { rootDir, record, path } = fixture(t);
  writeFileSync(join(rootDir, 'data/follow-up-jobs/merge-agent-dispatches/second.json'),
    JSON.stringify({ ...record, prNumber: 8 }));
  const calls = [];
  const driver = createOverloadRescueRetry({ rootDir, readConfig: enabledConfig, now: () => 2000_000,
    logger: { warn() {} }, execute: async (_command, args) => {
      calls.push(args[2]);
      throw new Error('synthetic observation unavailable');
    } });
  await driver.tick();
  await driver.tick();
  assert.deepEqual(calls, ['7', '8']);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pendingHandoff, true);
});

test('failed rescue backs off exponentially', async t => {
  const { rootDir, record, write } = fixture(t);
  record.overloadDeferral.overloadAlert = true;
  record.overloadDeferral.nextRetryAt = null;
  write();
  let now = 2000_000;
  let calls = 0;
  const driver = createOverloadRescueRetry({ rootDir, readConfig: enabledConfig,
    now: () => now, logger: { warn() {} }, execute: async () => {
      calls++;
      throw new Error('unavailable');
    } });
  await driver.tick();
  await driver.tick();
  assert.equal(calls, 1);
  now += 30_000;
  await driver.tick();
  assert.equal(calls, 2);
  now += 30_000;
  await driver.tick();
  assert.equal(calls, 2);
  now += 30_000;
  await driver.tick();
  assert.equal(calls, 3);
});

test('live kill switches suppress rescue and unreadable config fails closed', async t => {
  const { rootDir } = fixture(t);
  let cfg = enabledConfig();
  let calls = 0;
  const driver = createOverloadRescueRetry({ rootDir, now: () => 2000_000,
    readConfig: () => { if (cfg === null) throw new Error('unreadable'); return cfg; },
    logger: { warn() {} }, execute: async () => { calls++; } });
  for (const disabled of [{ enabled: false }, { autonomousMergeExecutionEnabled: false }, null]) {
    cfg = disabled;
    await driver.tick();
    assert.equal(calls, 0);
  }
  cfg = enabledConfig();
  await driver.tick();
  assert.equal(calls, 1);
  cfg = { autonomousMergeExecutionEnabled: false };
  await driver.tick();
  assert.equal(calls, 1);
});

test('scan caps content reads per tick and advances past irrelevant history to old debt', async t => {
  const { rootDir, path } = fixture(t);
  const directory = join(rootDir, 'data/follow-up-jobs/merge-agent-dispatches');
  for (let i = 0; i < 9; i++) writeFileSync(join(directory, `history-${i}.json`), '{}');
  let reads = 0;
  let calls = 0;
  const visited = new Set();
  const driver = createOverloadRescueRetry({ rootDir, readConfig: enabledConfig, scanLimit: 2,
    now: () => 2000_000, readReceipt: async file => {
      reads++;
      visited.add(file);
      return readFileSync(file, 'utf8');
    }, execute: async () => { calls++; } });
  for (let i = 0; i < 6; i++) {
    reads = 0;
    await driver.tick();
    assert.ok(reads <= 3, 'two scanned receipts plus one post-child progress read');
  }
  assert.equal(visited.size, 10);
  assert.ok(visited.has(path));
  assert.equal(calls, 1);
});

test('all due receipts in a scan window run before scanning the next window', async t => {
  const { rootDir, record } = fixture(t);
  const directory = join(rootDir, 'data/follow-up-jobs/merge-agent-dispatches');
  // Deterministic directory order makes a dropped candidate visible immediately.
  const names = ['first.json', 'second.json', 'history-1.json', 'history-2.json'];
  names.forEach((name, index) => writeFileSync(join(directory, name),
    JSON.stringify(index < 2 ? { ...record, prNumber: index + 10 } : {})));
  let position = 0;
  let scans = 0;
  const calls = [];
  const driver = createOverloadRescueRetry({ rootDir, readConfig: enabledConfig, scanLimit: 2,
    now: () => 2000_000, logger: { warn() {} },
    openDirectory: async () => ({
      read: async () => {
        scans++;
        const name = names[position++];
        return name ? { name, isFile: () => true } : null;
      },
      close: async () => {},
    }),
    execute: async (_cmd, args) => { calls.push(args[2]); } });
  t.after(() => driver.stop());
  await driver.tick();
  await driver.tick();
  assert.deepEqual(calls, ['10', '11']);
  assert.equal(scans, 2, 'both candidates must run without another directory rotation');
});

test('successful no-op rescues back off like failures', async t => {
  const { rootDir, record, write } = fixture(t);
  record.overloadDeferral.overloadAlert = true;
  record.overloadDeferral.nextRetryAt = null;
  write();
  let now = 2000_000;
  let calls = 0;
  const driver = createOverloadRescueRetry({ rootDir, readConfig: enabledConfig,
    now: () => now, logger: { warn() {} }, execute: async () => { calls++; } });
  t.after(() => driver.stop());
  await driver.tick();
  now += 30_000;
  await driver.tick();
  assert.equal(calls, 2);
  now += 30_000;
  await driver.tick();
  assert.equal(calls, 2);
  now += 30_000;
  await driver.tick();
  assert.equal(calls, 3);
});

test('a failed directory handle is closed and reopened on the next tick', async t => {
  const { rootDir } = fixture(t);
  let opens = 0;
  let closes = 0;
  let calls = 0;
  const driver = createOverloadRescueRetry({ rootDir, readConfig: enabledConfig,
    now: () => 2000_000, logger: { warn() {} },
    openDirectory: async path => {
      if (++opens > 1) return opendir(path);
      return { read: async () => { throw new Error('synthetic EIO'); },
        close: async () => { closes++; } };
    }, execute: async () => { calls++; } });
  t.after(() => driver.stop());
  await driver.tick();
  assert.equal(closes, 1);
  await driver.tick();
  assert.equal(opens, 2);
  assert.equal(calls, 1);
});

test('shutdown aborts the active rescue and prevents later rescues', async t => {
  const { rootDir } = fixture(t);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let calls = 0;
  let aborted = false;
  const driver = createOverloadRescueRetry({ rootDir, readConfig: enabledConfig,
    now: () => 2000_000, logger: { warn() {} },
    execute: async (_cmd, _args, { signal }) => {
      calls++;
      started();
      await new Promise(resolve => signal.addEventListener('abort', () => {
        aborted = true;
        resolve();
      }, { once: true }));
    } });
  const ticking = driver.tick();
  await ready;
  await driver.stop();
  await ticking;
  await driver.tick();
  assert.equal(aborted, true);
  assert.equal(calls, 1);
});
