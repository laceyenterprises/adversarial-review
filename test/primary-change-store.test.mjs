import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storedHistoryRead, storedPrimaryChange, primaryChangeReadStatus, sweepPrimaryChangeStore, verifiedReversalRecord } from '../src/ama/primary-change-store.mjs';

test('history progress keeps completed reads only, isolates heads and expires as a whole history', async t => {
  const args = fixture(t);
  let computes = 0;
  const compute = async () => { computes++; return { author: 'synthetic-author' }; };
  assert.deepEqual(await storedHistoryRead(args, ['page', 1], compute), { author: 'synthetic-author' });
  await storedHistoryRead(args, ['page', 1], compute);
  assert.equal(computes, 1);
  const controller = new AbortController();
  await assert.rejects(storedHistoryRead(args, ['page', 2], async () => {
    controller.abort(new Error('cancelled')); return {};
  }, controller.signal), /cancelled/);
  await storedHistoryRead(args, ['page', 2], compute);
  assert.equal(computes, 2, 'late completion after cancellation was never saved');
  await storedHistoryRead({ ...args, headSha: 'd'.repeat(40) }, ['page', 1], compute);
  assert.equal(computes, 3);
  const removed = sweepPrimaryChangeStore(args.rootDir, { nowMs: Date.now() + 8 * 86400000 });
  assert.equal(removed.length, 2);
  assert.ok(removed.every(path => !existsSync(path)));
});

test('partial history treats corrupt records as missing and refuses symlinked progress before compute', async t => {
  const args = fixture(t);
  await storedHistoryRead(args, ['page', 1], async () => ({ author: 'fixture' }));
  const dir = join(args.rootDir, 'data', 'primary-change-history');
  const progress = join(dir, readdirSync(dir).find(name => name.startsWith('progress-')));
  const record = join(progress, readdirSync(progress)[0]);
  for (const value of ['{broken', 'null', '{}']) {
    writeFileSync(record, value);
    assert.deepEqual(await storedHistoryRead(args, ['page', 1], async () => ({ author: 'recomputed' })),
      { author: 'recomputed' });
  }
  rmSync(record);
  symlinkSync(join(args.rootDir, 'foreign-record'), record);
  await assert.rejects(storedHistoryRead(args, ['page', 1], () => assert.fail('must not compute')), /symlink/);
  rmSync(progress, { recursive: true });
  symlinkSync(args.rootDir, progress);
  await assert.rejects(storedHistoryRead(args, ['page', 1], () => assert.fail('must not compute')), /symlink/);
});

function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'pccslow-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, repo: 'fixture/repo', prNumber: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), mergeBase: 'c'.repeat(40) };
}
const evidence = args => ({ headSha: args.headSha, hasHammerCommits: true, mergeBase: args.mergeBase, primaryFiles: [], finalFiles: [] });

function mockFs(t, name, implementation) {
  t.mock.method(fs, name, implementation);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test('foreign runtime root, data directory, store or record refuses access before compute or mutation', async t => {
  for (const target of ['root', 'data', 'store', 'record']) {
    await t.test(target, async t => {
      const args = fixture(t);
      const dataDir = join(args.rootDir, 'data');
      const dir = join(dataDir, 'primary-change-history');
      let path;
      if (target === 'data') mkdirSync(dataDir);
      if (target === 'store') mkdirSync(dir, { recursive: true });
      if (target === 'record') {
        await storedPrimaryChange(args, async () => evidence(args));
        path = join(dir, readdirSync(dir)[0]);
        assert.equal(statSync(path).mode & 0o777, 0o600);
        assert.equal(statSync(path).uid, process.geteuid());
      }
      const foreignPath = { root: args.rootDir, data: dataDir, store: dir, record: path }[target];
      const original = fs.lstatSync;
      mockFs(t, 'lstatSync', (candidate, ...options) => {
        const stat = original(candidate, ...options);
        // Node 22's rmSync also uses lstatSync during fixture cleanup. Preserve
        // the complete Stats interface while simulating only foreign ownership.
        if (candidate === foreignPath) stat.uid = process.geteuid() + 1;
        return stat;
      });
      await assert.rejects(storedPrimaryChange(args, () => { assert.fail('must refuse before expensive compute'); }), /canonical daemon owner/);
      if (target === 'root') assert.equal(existsSync(dataDir), false);
      if (target === 'data') assert.deepEqual(readdirSync(dataDir), []);
      if (target === 'store') assert.deepEqual(readdirSync(dir), []);
      if (target === 'record') {
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).history, evidence(args));
        utimesSync(path, new Date(0), new Date(0));
        assert.throws(() => sweepPrimaryChangeStore(args.rootDir), /canonical daemon owner/);
        assert.equal(existsSync(path), true);
      }
    });
  }
});

test('ownership is checked again after asynchronous compute before publishing', async t => {
  const args = fixture(t);
  const dir = join(args.rootDir, 'data', 'primary-change-history');
  const original = fs.lstatSync;
  let foreign = false;
  mockFs(t, 'lstatSync', (path, ...options) => {
    const stat = original(path, ...options);
    if (path === dir && foreign) stat.uid = process.geteuid() + 1;
    return stat;
  });
  await assert.rejects(storedPrimaryChange(args, async () => {
    mkdirSync(dir, { recursive: true });
    foreign = true;
    return evidence(args);
  }), /canonical daemon owner/);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(primaryChangeReadStatus(args), null);
  foreign = false;
  await storedPrimaryChange(args, async () => evidence(args));
});

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

test('pre-deploy reversal refusals recompute once at an unchanged head and review key', async t => {
  const args = { ...fixture(t), reviewKey: 'unchanged-reviews' };
  const dir = join(args.rootDir, 'data', 'primary-change-history');
  mkdirSync(dir, { recursive: true });
  const key = [args.repo, args.prNumber, args.baseSha, args.headSha, args.mergeBase, args.reviewKey, null, 'reversalproof-v6'];
  const legacyPath = join(dir, `${createHash('sha256').update(JSON.stringify(key)).digest('hex')}.json`);
  writeFileSync(legacyPath, JSON.stringify({ key, history: { ...evidence(args),
    rejectedReversalAuthorizations: [{ reason: 'original-reversal-not-proven-before-supersession', detail: 'no candidate with the same commit message' }] } }));
  let calls = 0;
  const refreshed = await storedPrimaryChange(args, async () => { calls++; return evidence(args); });
  assert.equal(refreshed.rejectedReversalAuthorizations, undefined);
  assert.equal(calls, 1);
  assert.deepEqual(await storedPrimaryChange(args, () => assert.fail('must reuse refreshed history')), refreshed);
  const currentPath = join(dir, readdirSync(dir).find(name => join(dir, name) !== legacyPath));
  assert.equal(JSON.parse(readFileSync(currentPath, 'utf8')).key.at(-1), 'reversalproof-v7');
  const catalog = JSON.parse(readFileSync(new URL('../docs/data-model/catalog.json', import.meta.url), 'utf8'));
  const entry = catalog.entries.find(entry => entry.id === 'primary-change-history');
  assert.equal(entry.identityVersion, 'reversalproof-v7');
  assert.ok(entry.optionalHistoryFields.includes('laneReversalHistory'));
  assert.match(entry.laneReversalProof, /laneOwner and laneIdentity/);
});

test('REVERSALPROOF-01: verified observations survive cache expiry and remain PR/patch scoped', async t => {
  const args = fixture(t);
  const record = { authorization: { review: { node_id: 'PRR_synthetic' } }, regions: [{ path: 'src/example.mjs' }] };
  await verifiedReversalRecord(args, 'synthetic-patch-identity', record);
  const dir = join(args.rootDir, 'data', 'primary-change-history');
  const path = join(dir, readdirSync(dir).find(name => name.startsWith('verified-')));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  utimesSync(path, new Date(0), new Date(0));
  assert.deepEqual(sweepPrimaryChangeStore(args.rootDir), []);
  assert.deepEqual(await verifiedReversalRecord(args, 'synthetic-patch-identity'), record);
  assert.equal(await verifiedReversalRecord({ ...args, prNumber: 2 }, 'synthetic-patch-identity'), null);
  assert.equal(await verifiedReversalRecord({ ...args, repo: 'other/repo' }, 'synthetic-patch-identity'), null);
  assert.equal(await verifiedReversalRecord(args, 'changed-patch-identity'), null);
  writeFileSync(path, '{broken');
  assert.equal(await verifiedReversalRecord(args, 'synthetic-patch-identity'), null);
});

test('verified reversal reads treat malformed and non-object JSON as missing evidence', async t => {
  const args = fixture(t);
  const patchIdentity = 'synthetic-patch-identity';
  const record = { authorization: {}, regions: [] };
  await verifiedReversalRecord(args, patchIdentity, record);
  const dir = join(args.rootDir, 'data', 'primary-change-history');
  const path = join(dir, readdirSync(dir).find(name => name.startsWith('verified-')));
  for (const contents of ['', '{broken', 'null', 'true', 'false', '42', '"text"', '[]', '{}']) {
    await t.test(JSON.stringify(contents), async () => {
      writeFileSync(path, contents);
      assert.equal(await verifiedReversalRecord(args, patchIdentity), null);
    });
  }
  await verifiedReversalRecord(args, patchIdentity, record);
  assert.deepEqual(await verifiedReversalRecord(args, patchIdentity), record);
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

test('sweep skips a concurrently removed temporary file and still expires other records', async t => {
  const args = fixture(t);
  assert.deepEqual(sweepPrimaryChangeStore(args.rootDir), []);
  await storedPrimaryChange(args, async () => evidence(args));
  const dir = join(args.rootDir, 'data', 'primary-change-history');
  const expired = join(dir, readdirSync(dir)[0]);
  utimesSync(expired, new Date(0), new Date(0));
  const temporary = join(dir, 'vanishing.tmp');
  writeFileSync(temporary, 'in progress');
  const original = fs.statSync;
  mockFs(t, 'statSync', path => {
    if (path === temporary) rmSync(path);
    return original(path);
  });
  assert.deepEqual(sweepPrimaryChangeStore(args.rootDir), [expired]);
  assert.deepEqual(readdirSync(dir), []);
});

test('sweep propagates per-file errors other than ENOENT', async t => {
  const args = fixture(t);
  await storedPrimaryChange(args, async () => evidence(args));
  mockFs(t, 'statSync', () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); });
  assert.throws(() => sweepPrimaryChangeStore(args.rootDir), { code: 'EACCES' });
  assert.equal(readdirSync(join(args.rootDir, 'data', 'primary-change-history')).length, 1);
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


test('FINALCLOSE-01 worker computes fresh history without accessing a foreign-owned daemon cache', async t => {
  const { fetchPrimaryChange } = await import('../src/ama/primary-change.mjs');
  const args = fixture(t), original = fs.lstatSync;
  mockFs(t, 'lstatSync', (path, ...options) => {
    const stat = original(path, ...options);
    if (path === args.rootDir) stat.uid = process.geteuid() + 1;
    return stat;
  });
  let reads = 0;
  const get = Object.assign(async path => {
    reads++;
    if (path.endsWith('/pulls/1')) return { head: { sha: args.headSha }, base: { sha: args.baseSha } };
    assert.ok(path.includes('/compare/'));
    return { total_commits: 1, commits: [{ sha: args.headSha, commit: { message: 'builder' } }] };
  }, { persistPrimaryChange: true, metadata: async () => assert.fail('cache preflight must not run') });
  for (let i = 0; i < 2; i++) {
    const result = await fetchPrimaryChange({ ...args, get }, { fetchCiCostImpl: async () => ({ ok: true }) });
    assert.equal(result.hasHammerCommits, false);
    assert.equal(result.historyReadFailed, undefined);
  }
  assert.equal(reads, 4, 'each lease evaluation independently reads live history');
  assert.equal(existsSync(join(args.rootDir, 'data', 'primary-change-history')), false);
});


test('completed history publication removes its partial progress', async t => {
  const args = fixture(t);
  await storedHistoryRead(args, ['page', 1], async () => ({ complete: true }));
  await storedPrimaryChange(args, async () => evidence(args));
  const names = readdirSync(join(args.rootDir, 'data', 'primary-change-history'));
  assert.equal(names.length, 1);
  assert.ok(!names[0].startsWith('progress-'));
});

test('progress byte eviction is separate from the 512 completed-record allowance', async t => {
  const args = fixture(t);
  const dir = join(args.rootDir, 'data', 'primary-change-history');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 512; i++) writeFileSync(join(dir, `${i}.json`), '{}');
  for (let i = 0; i < 2; i++) {
    await storedHistoryRead({ ...args, headSha: String(i + 1).repeat(40) }, ['page', 1], async () => 'x'.repeat(1024));
  }
  const progress = readdirSync(dir).filter(name => name.startsWith('progress-'));
  utimesSync(join(dir, progress[0]), new Date(1000), new Date(1000));
  utimesSync(join(dir, progress[1]), new Date(2000), new Date(2000));
  const removed = sweepPrimaryChangeStore(args.rootDir, { nowMs: 3000, progressMaxBytes: 1800 });
  assert.deepEqual(removed, [join(dir, progress[0])]);
  assert.equal(readdirSync(dir).filter(name => name.endsWith('.json')).length, 512);
  assert.ok(existsSync(join(dir, progress[1])));
});

test('a sweep racing checkpoint publication cannot fail a completed read', async t => {
  const args = fixture(t);
  const original = fs.writeFileSync;
  mockFs(t, 'writeFileSync', (path, ...options) => {
    if (path.endsWith('.tmp') && path.includes('progress-')) rmSync(join(path, '..'), { recursive: true });
    return original(path, ...options);
  });
  assert.deepEqual(await storedHistoryRead(args, ['page', 1], async () => ({ complete: true })), { complete: true });
});
