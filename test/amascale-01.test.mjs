import { alertPresentationForDoc } from '../src/alert-delivery.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveCloserCap, launchHoldsCloserCapacity } from '../src/ama/closure-capacity.mjs';
import { observeCloserBacklog, observeClosureLag } from '../src/ama/closure-lag.mjs';
import { createAmaHammerBackgroundQueue } from '../src/ama-hammer-background-dispatch.mjs';

function root(t) {
  const dir = mkdtempSync(join(tmpdir(), 'amascale-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('five parked hammers consume no capacity; only live launch states count', () => {
  assert.equal(Array.from({ length: 5 }, () => ({ status: 'blocked_needs_decision' })).filter(launchHoldsCloserCapacity).length, 0);
  for (const status of ['requested', 'leased', 'starting', 'running']) assert.equal(launchHoldsCloserCapacity({ status }), true);
  for (const status of ['parked', 'failed', 'dismissed', 'succeeded', 'unknown']) assert.equal(launchHoldsCloserCapacity({ status }), false);
  assert.equal(launchHoldsCloserCapacity({ status: 'running', pid: 123 }, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }), false);
  assert.equal(effectiveCloserCap(10, 3, 32), 10);
  assert.equal(effectiveCloserCap(100, 3, 32), 32);
  assert.equal(effectiveCloserCap(0, 12, 32), 12);
});

test('ten eligible PRs launch concurrently; admission refusal passes through', async (t) => {
  const rootDir = root(t);
  const queue = createAmaHammerBackgroundQueue({ maxConcurrent: 3, ceiling: 32 });
  let finish;
  const wait = new Promise((resolve) => { finish = resolve; });
  let launched = 0;
  for (let prNumber = 1; prNumber <= 10; prNumber++) {
    assert.equal(observeCloserBacklog({ rootDir, repo: 'test/repo', prNumber }), prNumber);
    queue.submit({ key: `test/repo#${prNumber}@head`, run: async () => { launched++; await wait; return { reason: 'worker-admission-memory-pressure' }; } });
  }
  assert.equal(launched, 10);
  assert.equal(queue.snapshot().limit, 10);
  finish();
  await queue.drain();
  assert.equal(queue.takeSettled('test/repo#1@head').result.reason, 'worker-admission-memory-pressure');
});

test('closure lag emits one completion metric and pages each breach once across restarts', async (t) => {
  const rootDir = root(t);
  const events = [], pages = [];
  const args = { rootDir, repo: 'test/repo', prNumber: 1, headSha: 'head',
    logger: { info: (text) => events.push(JSON.parse(text)) }, pageImpl: async (text) => pages.push(text) };
  await observeClosureLag({ ...args, eligible: true, now: 1000, reason: 'merge-lease-held' });
  await observeClosureLag({ ...args, now: 1801001, reason: 'merge-lease-held' });
  await observeClosureLag({ ...args, now: 1801002, reason: 'merge-lease-held' });
  assert.equal(pages.length, 1);
  await observeClosureLag({ ...args, now: 3601001, reason: 'merge-lease-held' });
  await observeClosureLag({ ...args, now: 3601002, reason: 'merge-lease-held' });
  assert.equal(pages.length, 2);
  assert.match(pages[1], /merge-lease-held/);
  await observeClosureLag({ ...args, now: 3602000, merged: true });
  await observeClosureLag({ ...args, now: 3602000, merged: true });
  assert.equal(events.filter((event) => event.event === 'ama.closure_lag').length, 1);
  assert.equal(events.at(-1).value, 0);
});


test('closure-lag pages present the SEV1 and name the blocking PR and reason', () => {
  const alert = alertPresentationForDoc({ event: 'ama.closure_lag.slo_breach', text: 'lag breach',
    payload: { blockers: [{ pr: 'test/repo#1', reason: 'merge-lease-held', lag_ms: 3600001 }] } });
  assert.equal(alert.severity, 'SEV1');
  assert.equal(alert.headline, 'AMA closure lag SLO breached');
  assert.match(alert.detail, /test\/repo#1: merge-lease-held/);
});
