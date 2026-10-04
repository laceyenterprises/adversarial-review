import { alertPresentationForDoc } from '../src/alert-delivery.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, statSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import fsExt from 'fs-ext';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
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
  assert.equal(launchHoldsCloserCapacity({ status: 'running', pid: 123 }, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }), true);
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
    assert.equal(await observeCloserBacklog({ rootDir, repo: 'test/repo', prNumber }), prNumber);
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

test('contended lag lock leaves timers and IO responsive and times out safely', { timeout: 5000 }, async (t) => {
  const rootDir = root(t);
  await observeCloserBacklog({ rootDir, repo: 'test/repo', prNumber: 1 });
  const dir = join(rootDir, 'data', 'ama-closure-lag');
  const before = readFileSync(join(dir, 'state.json'), 'utf8');
  const fd = openSync(join(dir, 'state.lock'), 'a');
  fsExt.flockSync(fd, 'ex');
  try {
    const observation = observeCloserBacklog({ rootDir, repo: 'test/repo', prNumber: 2 });
    let settled = false;
    observation.then(() => { settled = true; }, () => { settled = true; });
    const rejection = assert.rejects(observation, (error) => ['EAGAIN', 'EWOULDBLOCK'].includes(error.code));
    await delay(50);
    assert.equal(settled, false);
    assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), before);
    await rejection;
  } finally { fsExt.flockSync(fd, 'un'); closeSync(fd); }
  assert.equal(await observeCloserBacklog({ rootDir, repo: 'test/repo', prNumber: 2 }), 2);
});

test('parse failures quarantine bad state and recover the census', async (t) => {
  const rootDir = root(t);
  const args = { rootDir, repo: 'test/repo', prNumber: 1 };
  await observeCloserBacklog(args);
  const path = join(rootDir, 'data', 'ama-closure-lag', 'state.json');
  writeFileSync(path, 'invalid JSON');
  assert.equal(await observeCloserBacklog({ ...args, logger: {} }), 1);
  const quarantine = readdirSync(join(rootDir, 'data', 'ama-closure-lag')).find((name) => name.startsWith('state.json.corrupt-'));
  assert.equal(readFileSync(join(rootDir, 'data', 'ama-closure-lag', quarantine), 'utf8'), 'invalid JSON');
  assert.equal(await observeCloserBacklog(args), 1);
});

test('concurrent lag writers serialize without losing observations or exhausting IO workers', { timeout: 5000 }, async (t) => {
  const rootDir = root(t);
  const counts = await Promise.all(Array.from({ length: 16 }, (_, i) =>
    observeCloserBacklog({ rootDir, repo: 'test/repo', prNumber: i + 1, now: 1000 })));
  assert.deepEqual(counts.sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i + 1));
});

test('terminal and orphan PR breaches are removed while active breach dedupe survives', async (t) => {
  const rootDir = root(t);
  const args = { rootDir, repo: 'test/repo', headSha: 'head', logger: {}, pageImpl: async () => {} };
  for (const prNumber of [1, 2, 3]) {
    await observeClosureLag({ ...args, prNumber, eligible: true, now: 1000 });
  }
  await observeClosureLag({ ...args, prNumber: 3, now: 3601001 });
  const path = join(rootDir, 'data', 'ama-closure-lag', 'state.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.breaches['pr:test/repo#1'].paged = false;
  state.breaches['pr:missing/repo#99'] = { event: {}, paged: false };
  writeFileSync(path, JSON.stringify(state));
  await observeCloserBacklog({ rootDir, repo: 'test/repo', prNumber: 3, now: 3601002 });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).breaches['pr:missing/repo#99'], undefined);
  await observeClosureLag({ ...args, prNumber: 1, merged: true, now: 3601003 });
  await observeClosureLag({ ...args, prNumber: 2, closed: true, now: 3601004 });
  const terminal = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(terminal.breaches).sort(), ['p95', 'pr:test/repo#3']);
  assert.equal(terminal.breaches['pr:test/repo#3'].paged, true);
  const pages = [];
  await observeClosureLag({ ...args, prNumber: 3, now: 90001005, pageImpl: async (text) => pages.push(text) });
  const pruned = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(pruned.prs['test/repo#1'], undefined);
  assert.equal(pruned.prs['test/repo#2'], undefined);
  assert.equal(pruned.breaches['pr:test/repo#3'].paged, true);
  assert.deepEqual(pages, []);
});

for (const transition of [{ eligible: false }, { headSha: 'new-head' }]) {
  test(`eligibility invalidation stops pages: ${JSON.stringify(transition)}`, async (t) => {
    const pages = [];
    const args = { rootDir: root(t), repo: 'test/repo', prNumber: 1, headSha: 'head', logger: {}, pageImpl: async (text) => pages.push(text) };
    await observeClosureLag({ ...args, eligible: true, now: 1000 });
    await observeClosureLag({ ...args, ...transition, now: 2000 });
    const result = await observeClosureLag({ ...args, ...transition, now: 7201000 });
    assert.equal(result.events.at(-1).value, 0);
    assert.deepEqual(pages, []);
  });
}
test('reopened eligible PR starts a fresh wait and rejoins backlog', async (t) => {
  const args = { rootDir: root(t), repo: 'test/repo', prNumber: 1, headSha: 'head', logger: {}, pageImpl: async () => {} };
  await observeClosureLag({ ...args, eligible: true, now: 1000 });
  await observeClosureLag({ ...args, closed: true, now: 2000 });
  const result = await observeClosureLag({ ...args, eligible: true, now: 3000 });
  assert.equal(result.events.at(-1).value, 1);
  assert.equal(result.events.at(-1).p95_lag_ms, 0);
  assert.equal(await observeCloserBacklog({ ...args, now: 3000 }), 1);
});
test('large backlogs produce bounded SEV1 pages with omitted counts', async (t) => {
  const rootDir = root(t), pages = [];
  const args = { rootDir, repo: 'test/repo', headSha: 'head', logger: {}, pageImpl: async (text) => pages.push(text) };
  for (let prNumber = 1; prNumber <= 20; prNumber++) await observeClosureLag({ ...args, prNumber, eligible: true, now: 1000 });
  const result = await observeClosureLag({ ...args, prNumber: 1, now: 1801001 });
  const breach = result.breaches.find((event) => event.id === 'p95');
  assert.equal(breach.blockers.length, 5);
  assert.equal(breach.blockers_omitted, 15);
  assert.ok(pages.every((text) => text.length <= 3500));
});

test('unchanged lag observations preserve the state inode without fsync replacement', async (t) => {
  const rootDir = root(t);
  const args = { rootDir, repo: 'test/repo', prNumber: 1, headSha: 'head', eligible: true, now: 1000, logger: {}, pageImpl: async () => {} };
  await observeClosureLag(args);
  const path = join(rootDir, 'data', 'ama-closure-lag', 'state.json');
  const before = statSync(path);
  await observeClosureLag({ ...args, now: 2000 });
  assert.equal(statSync(path).ino, before.ino);
  assert.equal(statSync(path).mtimeMs, before.mtimeMs);
});
