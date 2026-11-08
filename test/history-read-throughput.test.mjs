import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { createHistoryReader } from '../src/ama/history-reader.mjs';
import { execHistoryFile } from '../src/ama/history-child.mjs';
import { fetchPrimaryChange, fetchPrimaryChangeHistoryClassification, checkPrimaryChange } from '../src/ama/primary-change.mjs';
import { currentGitHubBudgetScope } from '../src/rate-limit-throttle.mjs';

// Synthetic immutable history: only the reported shape (2 commits / 53 paths)
// comes from the incident. No private paths, messages, identities or credentials.
const sha = text => createHash('sha1').update(text).digest('hex');
const base = sha('base'), head = sha('head'), middle = sha('middle');
const repo = 'fixture/repo', path = `repos/${repo}/compare/${base}...${head}`;
// A nonexistent private fixture root prevents durable history writes/reuse.
const args = { repo, prNumber: 42, headSha: head, rootDir: join(tmpdir(), randomUUID()) };
const commit = (id, parent) => ({ sha: id, parents: [{ sha: parent }], commit: { message: 'author change' } });
function fixture({ failTree = false, stallTree = false, contextTimeoutMs, hammer = false, schedule } = {}) {
  const objects = new Map();
  const roots = [[], []];
  for (let i = 0; i < 53; i++) for (let side = 0; side < 2; side++) {
    const dir = sha(`dir-${i}-${side}`), blob = sha(`blob-${i}-${side}`);
    const bytes = Buffer.from(`${side ? 'new' : 'old'}-${i}\n`);
    roots[side].push({ path: `dir-${String(i).padStart(2, '0')}`, type: 'tree', mode: '040000', sha: dir });
    objects.set(`git/trees/${dir}`, { tree: [{ path: 'source.mjs', type: 'blob', mode: '100644', sha: blob }], truncated: false });
    objects.set(`git/blobs/${blob}`, { content: bytes.toString('base64'), size: bytes.length, encoding: 'base64' });
  }
  objects.set(`git/trees/${base}`, { tree: roots[0], truncated: false });
  objects.set(`git/trees/${head}`, { tree: roots[1], truncated: false });
  objects.set(`git/trees/${middle}`, { tree: roots[1], truncated: false });
  const counts = { compare: 0, tree: 0, blob: 0, live: 0, diff: 0 };
  let activeTrees = 0, peakTrees = 0;
  const transport = async ({ args, signal }) => {
    assert.ok(currentGitHubBudgetScope(), 'quota admission remains scoped');
    signal.throwIfAborted();
    const key = args[1].replace(`repos/${repo}/`, '');
    if (key.startsWith('compare/')) {
      counts.compare++;
      await schedule?.read('compare');
      const commits = key.split('?')[0].endsWith(middle) ? [commit(middle, base)]
        : [commit(middle, base), { ...commit(head, middle),
          commit: { message: hammer ? 'repair\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nClosed-By: hammer (adversarial-pipe-mode)' : 'author change' } }];
      return { stdout: JSON.stringify({ status: 'ahead', total_commits: commits.length,
        merge_base_commit: { sha: base }, commits }) };
    }
    if (key.startsWith('git/trees/')) {
      counts.tree++;
      activeTrees++;
      peakTrees = Math.max(peakTrees, activeTrees);
      try {
        await schedule?.read('tree');
        await turn();
        if (stallTree) return new Promise(() => {});
        if (failTree && ![base, head].some(ref => key.endsWith(ref))) return { stdout: '{"tree":[],"truncated":true}' };
      } finally { activeTrees--; }
    } else if (key.startsWith('git/blobs/')) {
      counts.blob++;
      await schedule?.read('blob');
    }
    else {
      counts.live++;
      if (key === 'pulls/42') return { stdout: JSON.stringify({ head: { sha: head }, base: { sha: base } }) };
      if (key.includes('/reviews?')) return { stdout: '[]' };
    }
    assert.ok(objects.has(key), `unexpected fixture request ${key}`);
    return { stdout: JSON.stringify(objects.get(key)) };
  };
  const get = createHistoryReader({ contextTimeoutMs, ...(schedule ? { nowMs: () => schedule.elapsedMs } : {}), execGhWithRetryImpl: transport,
    diffImpl: (...argv) => {
      counts.diff++;
      return execHistoryFile(...argv);
    } });
  return { get, counts, peakTrees: () => peakTrees };
}

test('LAC-2174: 53 independent directories retain all patches with bounded tree requests', async t => {
  const { get, counts, peakTrees } = fixture();
  const start = performance.now();
  const result = await get(path);
  assert.equal(result.filesComplete, true);
  assert.equal(result.files.length, 53);
  for (const [i, file] of result.files.entries()) {
    assert.equal(file.filename, `dir-${String(i).padStart(2, '0')}/source.mjs`);
    assert.equal(file.patch, `@@ -1 +1 @@\n-old-${i}\n+new-${i}\n`);
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 1);
  }
  assert.deepEqual(counts, { compare: 1, tree: 108, blob: 106, live: 0, diff: 53 });
  assert.equal(peakTrees(), 16, 'at most eight before/after directory pairs');
  // Deterministic latency model, excluding local filesystem/git: 2s/request.
  // Legacy DFS: metadata + root + 53 sibling pairs + seven blob waves.
  const legacyMs = (1 + 1 + 53 + 7) * 2000;
  const optimizedMs = (1 + 1 + Math.ceil(53 / 8) + 7) * 2000;
  assert.equal(legacyMs, 124000);
  assert.equal(optimizedMs, 32000);
  t.diagnostic(JSON.stringify({ counts, peakTreeRequests: peakTrees(), localWallMs: performance.now() - start,
    modeledRequestMs: 2000, legacyMs, optimizedMs }));
});

test('complete author-only classification avoids every tree/blob/diff request', async () => {
  const { get, counts } = fixture();
  const evidence = await fetchPrimaryChange({ ...args, get }, {
    fetchCiCostImpl: async () => ({ headSha: head, ok: true }),
  });
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
  assert.deepEqual(counts, { compare: 1, tree: 0, blob: 0, live: 1, diff: 0 });
});

test('classification and full proof share immutable commit pages but full proof still reads all patches', async () => {
  const { get, counts } = fixture();
  assert.equal((await get.commitHistory(path)).commits.length, 2);
  assert.equal((await get(path)).files.length, 53);
  assert.equal(counts.compare, 1);
  assert.equal(counts.blob, 106);
});

test('an incomplete tree still refuses complete evidence', async () => {
  const { get } = fixture({ failTree: true });
  await assert.rejects(get(path), /incomplete tree/);
});

test('deadline still fails closed during parallel tree collection', async () => {
  const { get, counts } = fixture({ stallTree: true, contextTimeoutMs: 50 });
  const pending = assert.rejects(get(path), { code: 'HISTORY_READ_TIMEOUT' });
  for (let i = 0; i < 100 && !counts.tree; i++) await turn();
  assert.equal(counts.tree, 2);
  await pending;
});

test('an incomplete commit page cannot become an author-only success', async () => {
  const get = createHistoryReader({ execGhWithRetryImpl: async ({ args: argv }) => ({ stdout: JSON.stringify(
    argv[1].includes('/pulls/') ? { head: { sha: head }, base: { sha: base } }
      : { total_commits: 2, commits: [commit(head, middle)], merge_base_commit: { sha: base } }) }) });
  const evidence = await fetchPrimaryChangeHistoryClassification({ ...args, get });
  assert.equal(checkPrimaryChange(evidence, head).ok, false);
  assert.match(evidence.reason, /incomplete compare pagination/);
});

test('hammer classification must hydrate complete primary and final evidence before approval', async () => {
  const { get, counts } = fixture({ hammer: true });
  const evidence = await fetchPrimaryChange({ ...args, get }, {
    fetchCiCostImpl: async () => ({ headSha: head, ok: true }),
  });
  assert.equal(evidence.hasHammerCommits, true);
  assert.equal(evidence.primaryFiles.length, 53);
  assert.equal(evidence.finalFiles.length, 53);
  assert.equal(evidence.completeFileLists, true);
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
  assert.ok(counts.diff >= 106);
});

test('history-only hammer classification reads all commits without patches', async () => {
  const { get, counts } = fixture({ hammer: true });
  const evidence = await fetchPrimaryChangeHistoryClassification({ ...args, get });
  assert.equal(evidence.hasHammerCommits, true);
  assert.deepEqual(counts, { compare: 1, tree: 0, blob: 0, live: 1, diff: 0 });
});

for (const mismatch of [false, true]) {
  test(`hydrated history ${mismatch ? 'rejects changed commits' : 'supports independent object copies'}`, async () => {
    const { get: source } = fixture({ hammer: true });
    const get = Object.assign(path => source(path), {
      commitHistory: async path => {
        const result = structuredClone(await source.commitHistory(path));
        if (mismatch) result.commits[0].commit.message = 'different evidence';
        return result;
      },
    });
    const evidence = await fetchPrimaryChange({ ...args, get }, {
      fetchCiCostImpl: async () => ({ headSha: head, ok: true }),
    });
    assert.equal(checkPrimaryChange(evidence, head).ok, !mismatch);
    if (mismatch) assert.match(evidence.reason, /commit history changed/);
  });
}

test('symbolic compare history remains live within the same reader', async () => {
  const { get, counts } = fixture();
  const symbolic = path.replace(base, 'main');
  await get.commitHistory(symbolic);
  await get.commitHistory(symbolic);
  assert.equal(counts.compare, 2);
  assert.equal(counts.tree, 0);
});

test('eager versus staged author-only collection yields the same decision with 216 versus 2 API reads', async t => {
  const eager = fixture(), staged = fixture();
  const options = { fetchCiCostImpl: async () => ({ headSha: head, ok: true }) };
  // Legacy capability-free transport forces the formerly eager full comparison.
  const before = await fetchPrimaryChange({ ...args, get: path => eager.get(path) }, options);
  const after = await fetchPrimaryChange({ ...args, get: staged.get }, options);
  assert.deepEqual(checkPrimaryChange(after, head), checkPrimaryChange(before, head));
  assert.equal(checkPrimaryChange(after, head).ok, true);
  const apiReads = counts => counts.compare + counts.tree + counts.blob + counts.live;
  assert.equal(apiReads(eager.counts), 216);
  assert.equal(apiReads(staged.counts), 2);
  assert.equal(eager.counts.diff, 53);
  assert.equal(staged.counts.diff, 0);
  t.diagnostic(JSON.stringify({ eager: eager.counts, staged: staged.counts }));
});

// A controlled API scheduler advances virtual time only when an entire request
// wave is admitted. Filesystem/git remain real but do not consume modeled time.
// Two-tree admission reproduces the legacy sibling-serial request schedule;
// sixteen-tree admission exercises the production bounded waves.
function latencySchedule(treeLimit) {
  const remaining = { compare: 1, tree: 108, blob: 106 };
  const queues = { compare: [], tree: [], blob: [] };
  const schedule = { elapsedMs: 0, waves: { compare: 0, tree: 0, blob: 0 }, read(stage) {
    return new Promise(resolve => {
      const limit = stage === 'compare' ? 1 : stage === 'tree' ? remaining.tree === 108 ? 2 : treeLimit : 16;
      const size = Math.min(limit, remaining[stage]);
      queues[stage].push(resolve);
      if (queues[stage].length === size) {
        schedule.elapsedMs += 2000;
        schedule.waves[stage]++;
        remaining[stage] -= size;
        for (const done of queues[stage].splice(0)) done();
      }
    });
  } };
  return schedule;
}

test('virtual legacy request schedule exhausts the canonical budget; bounded waves complete in 32 seconds', async t => {
  const legacy = latencySchedule(2);
  const before = fixture({ schedule: legacy });
  await assert.rejects(before.get(path), { code: 'HISTORY_READ_TIMEOUT' });
  assert.ok(legacy.elapsedMs >= 90000);
  assert.equal(before.counts.blob, 0, 'legacy schedule exhausts the budget during directory traversal');
  const optimized = latencySchedule(16);
  const after = fixture({ schedule: optimized });
  assert.equal((await after.get(path)).files.length, 53);
  assert.equal(optimized.elapsedMs, 32000);
  assert.deepEqual(optimized.waves, { compare: 1, tree: 8, blob: 7 });
  t.diagnostic(JSON.stringify({ legacy: { elapsedMs: legacy.elapsedMs, waves: legacy.waves, counts: before.counts },
    optimized: { elapsedMs: optimized.elapsedMs, waves: optimized.waves, counts: after.counts } }));
});
