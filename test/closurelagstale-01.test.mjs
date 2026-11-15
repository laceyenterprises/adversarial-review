// CLOSURELAGSTALE-01: a pending closure-lag wait whose per-PR breach already
// paged must still be reconciled against live PR state, so a merge the watcher
// never reported leaves the queue-depth gauge and stops latching the p95 breach.
import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIVE_READS_PER_PASS, PAGED_RECHECK_MS, observeClosureLag } from '../src/ama/closure-lag.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-01-30T00:00:00Z');
const REPO = 'fixture/repo';

function root(t) {
  const dir = mkdtempSync(join(tmpdir(), 'closurelagstale-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function statePath(rootDir) {
  return join(rootDir, 'data', 'ama-closure-lag', 'state.json');
}

function lagState(rootDir) {
  return JSON.parse(readFileSync(statePath(rootDir), 'utf8'));
}

// The stuck shape: eligible weeks ago, never marked terminal, its per-PR breach
// and the aggregate p95 breach both already paged.
function seedStuck(rootDir, count) {
  const state = { prs: {}, samples: [], sloMs: 1800000,
    breaches: { p95: { event: { event: 'ama.closure_lag.slo_breach', id: 'p95' }, paged: true } } };
  for (let n = 1; n <= count; n++) {
    const key = `${REPO}#${n}`;
    state.prs[key] = { headSha: `head-${n}`, eligibleAt: NOW - 30 * DAY + n * HOUR,
      reason: 'merge-pending', terminal: false };
    state.breaches[`pr:${key}`] = { event: { event: 'ama.closure_lag.slo_breach', id: `pr:${key}` }, paged: true };
  }
  mkdirSync(join(rootDir, 'data', 'ama-closure-lag'), { recursive: true });
  writeFileSync(statePath(rootDir), JSON.stringify(state));
}

function mergedSoonAfterEligible(rootDir) {
  const reads = [];
  return { reads, fetchLiveStateImpl: async (repo, prNumber) => {
    reads.push(prNumber);
    const eligibleAt = lagState(rootDir).prs[`${repo}#${prNumber}`].eligibleAt;
    return { state: 'MERGED', mergedAt: new Date(eligibleAt + 2 * HOUR).toISOString() };
  } };
}

// Another PR's observation drives reconciliation, as in a watcher pass.
function observeOther(rootDir, extra) {
  return observeClosureLag({ rootDir, repo: REPO, prNumber: 9999, headSha: 'other', logger: {},
    pageImpl: async () => assert.fail('no page expected'), ...extra });
}

test('a paged pending wait whose live PR merged becomes terminal and leaves the queue', async (t) => {
  const rootDir = root(t), pages = [];
  const args = { rootDir, repo: REPO, prNumber: 1, headSha: 'head', logger: {},
    pageImpl: async (_text, { payload }) => pages.push(payload.id), fetchLiveStateImpl: async () => ({ state: 'OPEN' }) };
  await observeClosureLag({ ...args, eligible: true, now: 1000 });
  await observeClosureLag({ ...args, now: 3601001 });
  assert.ok(pages.includes('pr:fixture/repo#1'));
  assert.equal(lagState(rootDir).breaches['pr:fixture/repo#1'].paged, true);
  // The merge happens outside any observed walk; only the live read can see it.
  const result = await observeClosureLag({ ...args, prNumber: 2, now: 3601001 + PAGED_RECHECK_MS,
    fetchLiveStateImpl: async () => ({ state: 'MERGED', mergedAt: new Date(5000).toISOString() }) });
  const state = lagState(rootDir);
  assert.equal(state.prs['fixture/repo#1'].terminal, true);
  assert.equal(state.breaches['pr:fixture/repo#1'], undefined);
  assert.equal(result.events.at(-1).event, 'ama.closure_queue_depth');
  assert.equal(result.events.at(-1).value, 0);
});

test('a paged open wait is re-read at most once per recheck interval', async (t) => {
  const rootDir = root(t);
  seedStuck(rootDir, 1);
  let reads = 0;
  const fetchLiveStateImpl = async () => { reads++; return { state: 'OPEN' }; };
  await observeOther(rootDir, { now: NOW, fetchLiveStateImpl });
  await observeOther(rootDir, { now: NOW + PAGED_RECHECK_MS - 1, fetchLiveStateImpl });
  assert.equal(reads, 1);
  await observeOther(rootDir, { now: NOW + PAGED_RECHECK_MS, fetchLiveStateImpl });
  assert.equal(reads, 2);
  const state = lagState(rootDir);
  assert.equal(state.prs['fixture/repo#1'].terminal, false);
  assert.equal(state.breaches['pr:fixture/repo#1'].paged, true);
});

test('thirty stale paged waits drain oldest first within the per-pass read bound', async (t) => {
  const rootDir = root(t);
  seedStuck(rootDir, 30);
  const { reads, fetchLiveStateImpl } = mergedSoonAfterEligible(rootDir);
  assert.equal(LIVE_READS_PER_PASS, 10);
  const depths = [];
  for (let pass = 0; pass < 4; pass++) {
    const before = reads.length;
    const result = await observeOther(rootDir, { now: NOW + pass, fetchLiveStateImpl });
    assert.ok(reads.length - before <= LIVE_READS_PER_PASS);
    depths.push(result.events.at(-1).value);
  }
  assert.deepEqual(reads, Array.from({ length: 30 }, (_, i) => i + 1));
  assert.deepEqual(depths, [20, 10, 0, 0]);
  const state = lagState(rootDir);
  assert.deepEqual(Object.keys(state.breaches).filter((id) => id.startsWith('pr:')), []);
});

test('after the stale waits drain the p95 breach clears and a new real breach pages again', async (t) => {
  const rootDir = root(t);
  seedStuck(rootDir, 30);
  const { fetchLiveStateImpl } = mergedSoonAfterEligible(rootDir);
  await observeOther(rootDir, { now: NOW, fetchLiveStateImpl });
  await observeOther(rootDir, { now: NOW + 1, fetchLiveStateImpl });
  assert.equal(lagState(rootDir).breaches.p95.paged, true);
  await observeOther(rootDir, { now: NOW + 2, fetchLiveStateImpl });
  // Month-old completions are dated at their merge, outside the 24-hour window.
  assert.equal(lagState(rootDir).breaches.p95, undefined);

  const pages = [];
  const args = { rootDir, repo: REPO, prNumber: 500, headSha: 'fresh', logger: {},
    pageImpl: async (_text, { payload }) => pages.push(payload.id), fetchLiveStateImpl: async () => ({ state: 'OPEN' }) };
  await observeClosureLag({ ...args, eligible: true, now: NOW + 10 });
  await observeClosureLag({ ...args, now: NOW + 10 + 1800001 });
  assert.deepEqual(pages, ['p95']);
  assert.equal(lagState(rootDir).breaches.p95.paged, true);
});

test('an overdue wait not yet paged is read ahead of the paged backlog', async (t) => {
  const rootDir = root(t);
  seedStuck(rootDir, 30);
  const reads = [], pages = [];
  const fetchLiveStateImpl = async (_repo, prNumber) => { reads.push(prNumber); return { state: 'OPEN' }; };
  const args = { rootDir, repo: REPO, prNumber: 600, headSha: 'fresh', logger: {}, fetchLiveStateImpl,
    pageImpl: async (_text, { payload }) => pages.push(payload.id) };
  await observeClosureLag({ ...args, eligible: true, now: NOW });
  reads.length = 0;
  await observeClosureLag({ ...args, now: NOW + HOUR + 1 });
  assert.equal(reads.length, LIVE_READS_PER_PASS);
  assert.equal(reads[0], 600);
  assert.ok(pages.includes('pr:fixture/repo#600'));
});

for (const failure of [
  { name: 'thrown read', impl: async () => { throw new Error('synthetic read failure'); } },
  { name: 'empty read', impl: async () => ({}) },
  { name: 'unknown state', impl: async () => ({ state: 'UNKNOWN' }) },
]) {
  test(`a failed or ambiguous live read leaves the paged wait pending: ${failure.name}`, async (t) => {
    const rootDir = root(t), warnings = [];
    seedStuck(rootDir, 1);
    const result = await observeOther(rootDir, { now: NOW, fetchLiveStateImpl: failure.impl,
      logger: { warn: (text) => warnings.push(text) } });
    const state = lagState(rootDir);
    assert.equal(state.prs['fixture/repo#1'].terminal, false);
    assert.equal(state.breaches['pr:fixture/repo#1'].paged, true);
    assert.equal(state.breaches.p95.paged, true);
    assert.equal(result.events.at(-1).value, 1);
    assert.equal(warnings.length, failure.name === 'thrown read' ? 1 : 0);
    // A later readable MERGED result still reconciles it.
    const { fetchLiveStateImpl } = mergedSoonAfterEligible(rootDir);
    await observeOther(rootDir, { now: NOW + PAGED_RECHECK_MS, fetchLiveStateImpl });
    assert.equal(lagState(rootDir).prs['fixture/repo#1'].terminal, true);
  });
}
