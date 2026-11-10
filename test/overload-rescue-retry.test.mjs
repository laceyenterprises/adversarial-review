import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    assert.ok(reads <= 2);
  }
  assert.equal(visited.size, 10);
  assert.ok(visited.has(path));
  assert.equal(calls, 1);
});
