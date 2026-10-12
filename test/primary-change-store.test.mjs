import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storedPrimaryChange, primaryChangeReadStatus, sweepPrimaryChangeStore } from '../src/ama/primary-change-store.mjs';

function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'pccslow-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, repo: 'fixture/repo', prNumber: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), mergeBase: 'c'.repeat(40) };
}
const evidence = args => ({ headSha: args.headSha, hasHammerCommits: true, mergeBase: args.mergeBase, primaryFiles: [], finalFiles: [] });

test('exact identity reuses disk evidence with no API; changed head, base, merge base or boundary recomputes', async t => {
  const args = fixture(t);
  let calls = 0;
  const compute = value => async () => { calls++; return evidence(value); };
  await storedPrimaryChange(args, compute(args));
  assert.deepEqual(await storedPrimaryChange(args, () => { throw new Error('API must not run'); }), evidence(args));
  for (const key of ['headSha', 'baseSha', 'mergeBase', 'reviewKey', 'launchHead']) {
    const changed = { ...args, [key]: 'd'.repeat(40) };
    await storedPrimaryChange(changed, compute(changed));
  }
  assert.equal(calls, 6);
});

test('timed out caller leaves a single read running, completion persists and next attempt reuses it', async t => {
  const args = fixture(t);
  let finish;
  let calls = 0;
  const pending = storedPrimaryChange(args, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  await Promise.resolve();
  const second = storedPrimaryChange(args, () => { throw new Error('duplicate read'); });
  assert.match(primaryChangeReadStatus(args), /primary-change read still running, \d+ seconds/);
  await assert.rejects(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('time limit')), 5))]), /time limit/);
  finish(evidence(args));
  await Promise.all([pending, second]);
  assert.equal(primaryChangeReadStatus(args), null);
  assert.deepEqual(await storedPrimaryChange(args, () => { throw new Error('API'); }), evidence(args));
  assert.equal(calls, 1);
});

test('failed and unknown reads are never stored; rejected read can retry', async t => {
  const args = fixture(t);
  for (const failure of [{ hasHammerCommits: null }, { hasHammerCommits: true, readFailed: true }]) {
    await storedPrimaryChange(args, async () => ({ ...evidence(args), ...failure }));
  }
  await assert.rejects(storedPrimaryChange(args, async () => { throw new Error('API failed'); }), /API failed/);
  await storedPrimaryChange(args, async () => evidence(args));
  assert.equal(readdirSync(join(args.rootDir, 'data', 'primary-change-history')).length, 1);
});

test('existing sweep expires obsolete records with fixed age bound', async t => {
  const args = fixture(t);
  await storedPrimaryChange(args, async () => evidence(args));
  const dir = join(args.rootDir, 'data', 'primary-change-history');
  const path = join(dir, readdirSync(dir)[0]);
  utimesSync(path, new Date(0), new Date(0));
  assert.deepEqual(sweepPrimaryChangeStore(args.rootDir), [path]);
});

test('production collector reuses history while checking live identity, reviews and cost', async t => {
  const { fetchPrimaryChange } = await import('../src/ama/primary-change.mjs');
  const args = fixture(t);
  let liveBase = args.baseSha;
  let liveHead = args.headSha;
  let reviews = [];
  let histories = 0, costs = 0;
  const get = Object.assign(async path => {
    if (path.endsWith('/pulls/1')) return { head: { sha: liveHead }, base: { sha: liveBase } };
    if (path.includes('/reviews?')) return reviews;
    histories++;
    return { total_commits: 1, commits: [{ sha: liveHead, commit: { message: 'builder' } }] };
  }, { persistPrimaryChange: true, metadata: async () => ({ merge_base_commit: { sha: args.mergeBase } }) });
  const read = () => fetchPrimaryChange({ ...args, headSha: liveHead, get }, {
    fetchCiCostImpl: async () => { costs++; return { headSha: liveHead, ok: true }; },
  });
  await read();
  await read();
  assert.equal(histories, 1);
  assert.equal(costs, 2);
  liveBase = 'e'.repeat(40);
  await read();
  liveHead = 'f'.repeat(40);
  await read();
  reviews = [{ state: 'DISMISSED', commit_id: liveHead }];
  await read();
  assert.equal(histories, 4);
});


test('CLI and daemon share tagged history; a used builder boundary must match an explicit ledger boundary', async t => {
  const args = fixture(t);
  const history = evidence(args);
  await storedPrimaryChange({ ...args, builderHead: 'd'.repeat(40) }, async () => history);
  assert.deepEqual(await storedPrimaryChange(args, () => { throw new Error('CLI API'); }), history);
  const bound = { ...args, headSha: 'e'.repeat(40) };
  await storedPrimaryChange(bound, async () => ({ ...evidence(bound), builderBoundary: 'f'.repeat(40) }));
  let reads = 0;
  await storedPrimaryChange({ ...bound, builderHead: 'd'.repeat(40) }, async () => { reads++; return evidence(bound); });
  assert.equal(reads, 1);
});
