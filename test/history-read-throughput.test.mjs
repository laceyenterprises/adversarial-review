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
import { withClosureEvaluationReadCache } from '../src/closure-evaluation-cache.mjs';
import { currentGitHubBudgetScope } from '../src/rate-limit-throttle.mjs';

// Synthetic immutable history: only the reported shape (2 commits / 53 paths)
// comes from the incident. No private paths, messages, identities or credentials.
const sha = text => createHash('sha1').update(text).digest('hex');
const base = sha('base'), head = sha('head'), middle = sha('middle');
const repo = 'fixture/repo', path = `repos/${repo}/compare/${base}...${head}`;
// A nonexistent private fixture root prevents durable history writes/reuse.
const args = { repo, prNumber: 42, headSha: head, rootDir: join(tmpdir(), randomUUID()) };
const commit = (id, parent) => ({ sha: id, parents: [{ sha: parent }], commit: { message: 'author change' } });
function fixture({ failTree = false, stallTree = false, contextTimeoutMs, hammer = false, schedule, recursive = false } = {}) {
  const objects = new Map();
  const roots = [[], []];
  for (let i = 0; i < 53; i++) for (let side = 0; side < 2; side++) {
    const blob = sha(`blob-${i}-${side}`);
    const body = Buffer.concat([Buffer.from('100644 source.mjs\0'), Buffer.from(blob, 'hex')]);
    const dir = createHash('sha1').update(`tree ${body.length}\0`).update(body).digest('hex');
    const bytes = Buffer.from(`${side ? 'new' : 'old'}-${i}\n`);
    roots[side].push({ path: `dir-${String(i).padStart(2, '0')}`, type: 'tree', mode: '040000', sha: dir });
    objects.set(`git/trees/${dir}`, { tree: [{ path: 'source.mjs', type: 'blob', mode: '100644', sha: blob }], truncated: false });
    objects.set(`git/blobs/${blob}`, { content: bytes.toString('base64'), size: bytes.length, encoding: 'base64' });
  }
  objects.set(`git/trees/${base}`, { tree: roots[0], truncated: false });
  objects.set(`git/trees/${head}`, { tree: roots[1], truncated: false });
  objects.set(`git/trees/${middle}`, { tree: roots[1], truncated: false });
  for (const [ref, side] of [[base, 0], [head, 1], [middle, 1]]) {
    objects.set(`git/trees/${ref}?recursive=1`, recursive ? { truncated: false,
      tree: roots[side].flatMap(entry => [entry, ...objects.get(`git/trees/${entry.sha}`).tree.map(child => ({ ...child, path: `${entry.path}/${child.path}` }))]),
    } : { tree: [], truncated: true });
  }
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
  return { get, transport, counts, peakTrees: () => peakTrees };
}

test('LAC-2174 fallback: 53 independent directories retain all patches with bounded tree requests', async t => {
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
  assert.deepEqual(counts, { compare: 1, tree: 110, blob: 106, live: 0, diff: 53 });
  assert.equal(peakTrees(), 16, 'at most eight before/after directory pairs');
  // Deterministic latency model, excluding local filesystem/git: 2s/request.
  // Fallback model: metadata + root/recursive attempt + 53 sibling pairs + seven blob waves.
  const legacyMs = (1 + 2 + 53 + 7) * 2000;
  const optimizedMs = (1 + 2 + Math.ceil(53 / 8) + 7) * 2000;
  assert.equal(legacyMs, 126000);
  assert.equal(optimizedMs, 34000);
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

test('a wide directory wave reaches child validation without exceeding argument limits', async () => {
  const wide = sha('wide-directory'), child = sha('truncated-wide-child');
  const requested = [];
  const get = createHistoryReader({ execGhWithRetryImpl: async ({ args: argv }) => {
    const key = argv[1];
    requested.push(key);
    if (key.startsWith(`${path}?`)) return { stdout: JSON.stringify({
      status: 'ahead', total_commits: 1, merge_base_commit: { sha: base }, commits: [commit(head, base)],
    }) };
    if (key.endsWith('?recursive=1')) return { stdout: '{"tree":[],"truncated":true}' };
    const ref = key.split('/').at(-1);
    let tree;
    if (ref === base) tree = [];
    else if (ref === head) tree = Array.from({ length: 8 }, (_, i) => ({
      path: `dir-${i}`, type: 'tree', mode: '040000', sha: wide,
    }));
    else if (ref === wide) tree = Array.from({ length: 20000 }, (_, i) => ({
      path: `child-${i}`, type: 'tree', mode: '040000', sha: child,
    }));
    else {
      assert.equal(ref, child);
      // Stop after enqueuing 160,000 children: the refusal must come from
      // incomplete evidence, rather than a runtime argument-count limit.
      return { stdout: JSON.stringify({ tree: [], truncated: true }) };
    }
    return { stdout: JSON.stringify({ tree, truncated: false }) };
  } });
  await assert.rejects(get(path), /incomplete tree/);
  assert.ok(requested.includes(`repos/${repo}/git/trees/${child}`));
});

test('a failed commit page stops new requests, settles active workers and permits retry', async () => {
  const requested = [];
  let failPage = true, active = 0;
  const get = createHistoryReader({ execGhWithRetryImpl: async ({ args: argv }) => {
    const number = Number(new URL(argv[1], 'https://fixture.invalid/').searchParams.get('page'));
    requested.push(number);
    active++;
    try {
      if (number > 1) {
        await turn();
        if (failPage && number === 2) throw new Error('fixture page failure');
        await turn();
      }
      return { stdout: JSON.stringify({
        status: 'ahead', total_commits: 1000, merge_base_commit: { sha: base },
        commits: Array.from({ length: 100 }, (_, i) => commit(sha(`page-commit-${(number - 1) * 100 + i}`), base)),
      }) };
    } finally { active--; }
  } });
  await assert.rejects(get.commitHistory(path), /fixture page failure/);
  assert.deepEqual(requested, [1, 2, 3, 4, 5], 'no additional pages dispatched after the failure');
  assert.equal(active, 0, 'already active reads settle before returning failure');
  failPage = false;
  const result = await get.commitHistory(path);
  assert.deepEqual(result.commits.map(commit => commit.sha),
    Array.from({ length: 1000 }, (_, i) => sha(`page-commit-${i}`)));
  assert.equal(active, 0);
});

test('deadline still fails closed during parallel tree collection', async () => {
  // Admit both root reads before exhausting the canonical budget. Wall-clock
  // scheduling under full-suite load must not expire the reader before trees.
  const schedule = { elapsedMs: 0, async read(stage) {
    if (stage === 'tree') {
      await turn();
      this.elapsedMs = 90000;
    }
  } };
  const { get, counts } = fixture({ schedule });
  await assert.rejects(get(path), { code: 'HISTORY_READ_TIMEOUT' });
  assert.equal(counts.tree, 2);
  assert.equal(counts.blob, 0);
  assert.equal(counts.diff, 0);
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

test('eager versus staged author-only collection yields the same decision with 218 versus 2 API reads', async t => {
  const eager = fixture(), staged = fixture();
  const options = { fetchCiCostImpl: async () => ({ headSha: head, ok: true }) };
  // Legacy capability-free transport forces the formerly eager full comparison.
  const before = await fetchPrimaryChange({ ...args, get: path => eager.get(path) }, options);
  const after = await fetchPrimaryChange({ ...args, get: staged.get }, options);
  assert.deepEqual(checkPrimaryChange(after, head), checkPrimaryChange(before, head));
  assert.equal(checkPrimaryChange(after, head).ok, true);
  const apiReads = counts => counts.compare + counts.tree + counts.blob + counts.live;
  assert.equal(apiReads(eager.counts), 218);
  assert.equal(apiReads(staged.counts), 2);
  assert.equal(eager.counts.diff, 53);
  assert.equal(staged.counts.diff, 0);
  t.diagnostic(JSON.stringify({ eager: eager.counts, staged: staged.counts }));
});

// A controlled API scheduler advances virtual time only when an entire request
// wave is admitted. Filesystem/git remain real but do not consume modeled time.
// Two-tree admission reproduces the legacy sibling-serial request schedule;
// sixteen-tree admission exercises the production bounded waves.
function latencySchedule(treeLimit, { recursive = false, requestMs = 2000 } = {}) {
  const remaining = { compare: 1, tree: recursive ? 4 : 110, blob: 106 };
  const queues = { compare: [], tree: [], blob: [] };
  const schedule = { elapsedMs: 0, waves: { compare: 0, tree: 0, blob: 0 }, read(stage) {
    return new Promise(resolve => {
      const limit = stage === 'compare' ? 1 : stage === 'tree' ? recursive || remaining.tree >= 108 ? 2 : treeLimit : 16;
      const size = Math.min(limit, remaining[stage]);
      queues[stage].push(resolve);
      if (queues[stage].length === size) {
        schedule.elapsedMs += requestMs;
        schedule.waves[stage]++;
        remaining[stage] -= size;
        for (const done of queues[stage].splice(0)) done();
      }
    });
  } };
  return schedule;
}

test('virtual legacy request schedule exhausts the canonical budget; bounded waves complete in 34 seconds', async t => {
  const legacy = latencySchedule(2);
  const before = fixture({ schedule: legacy });
  await assert.rejects(before.get(path), { code: 'HISTORY_READ_TIMEOUT' });
  assert.ok(legacy.elapsedMs >= 90000);
  assert.equal(before.counts.blob, 0, 'legacy schedule exhausts the budget during directory traversal');
  const optimized = latencySchedule(16);
  const after = fixture({ schedule: optimized });
  assert.equal((await after.get(path)).files.length, 53);
  assert.equal(optimized.elapsedMs, 34000);
  assert.deepEqual(optimized.waves, { compare: 1, tree: 9, blob: 7 });
  t.diagnostic(JSON.stringify({ legacy: { elapsedMs: legacy.elapsedMs, waves: legacy.waves, counts: before.counts },
    optimized: { elapsedMs: optimized.elapsedMs, waves: optimized.waves, counts: after.counts } }));
});

test('HAMHISTORYTHROUGHPUT-02: complete recursive snapshots retain identical patches with 104 fewer tree reads than the deployed path', async t => {
  const previous = fixture(), optimized = fixture({ recursive: true });
  const start = performance.now();
  const after = await optimized.get(path);
  assert.deepEqual(after, await previous.get(path));
  assert.deepEqual(optimized.counts, { compare: 1, tree: 4, blob: 106, live: 0, diff: 53 });
  assert.equal(previous.counts.tree, 110, 'explicit truncation safely falls back to the subtree walker');
  t.diagnostic(JSON.stringify({ fallback: previous.counts, optimized: optimized.counts, localWallMs: performance.now() - start,
    deployedApiReads: 215, optimizedApiReads: 111 }));
});

test('HAMHISTORYTHROUGHPUT-02: request reduction completes the same proof within the unchanged global budget', async t => {
  // Six seconds is an explicit synthetic transport model, not live latency.
  const fallbackSchedule = latencySchedule(16, { requestMs: 6000 });
  const fallback = fixture({ schedule: fallbackSchedule });
  await assert.rejects(fallback.get(path), { code: 'HISTORY_READ_TIMEOUT' });
  const schedule = latencySchedule(16, { recursive: true, requestMs: 6000 });
  const optimized = fixture({ recursive: true, schedule });
  const result = await optimized.get(path);
  assert.equal(result.filesComplete, true);
  assert.equal(result.files.length, 53);
  assert.equal(schedule.elapsedMs, 60000);
  assert.deepEqual(schedule.waves, { compare: 1, tree: 2, blob: 7 });
  t.diagnostic(JSON.stringify({ fallbackMs: fallbackSchedule.elapsedMs, optimizedMs: schedule.elapsedMs, counts: optimized.counts }));
});

for (const corruption of ['missing-marker', 'missing-root-entry', 'duplicate', 'orphan', 'wrong-sha', 'unknown-type', 'missing-child', 'wrong-mode']) {
  test(`recursive evidence fails closed on ${corruption}`, async () => {
    const blob = sha('recursive-blob');
    const body = Buffer.concat([Buffer.from('100644 file\0'), Buffer.from(blob, 'hex')]);
    const dir = createHash('sha1').update(`tree ${body.length}\0`).update(body).digest('hex');
    const root = { path: 'dir', mode: '040000', type: 'tree', sha: dir };
    const leaf = { path: 'dir/file', mode: '100644', type: 'blob', sha: blob };
    let blobs = 0;
    const get = createHistoryReader({ execGhWithRetryImpl: async ({ args: argv }) => {
      const key = argv[1];
      if (key.includes('/compare/')) return { stdout: JSON.stringify({ status: 'ahead', total_commits: 1,
        merge_base_commit: { sha: base }, commits: [commit(head, base)] }) };
      if (key.endsWith('?recursive=1')) {
        const data = { tree: [root, leaf], truncated: false };
        if (corruption === 'missing-marker') delete data.truncated;
        if (corruption === 'missing-root-entry') data.tree = [];
        if (corruption === 'missing-child') data.tree = [root];
        if (corruption === 'wrong-mode') data.tree[1] = { ...leaf, mode: '100755' };
        if (corruption === 'duplicate') data.tree.push(leaf);
        if (corruption === 'orphan') data.tree.push({ ...leaf, path: 'absent/file' });
        if (corruption === 'wrong-sha') data.tree[0] = { ...root, sha: blob };
        if (corruption === 'unknown-type') data.tree[1] = { ...leaf, type: 'unknown' };
        return { stdout: JSON.stringify(data) };
      }
      if (key.includes('/git/trees/')) return { stdout: JSON.stringify({ tree: key.endsWith(base) ? [] : [root], truncated: false }) };
      blobs++;
      throw new Error('must not read blobs from malformed evidence');
    } });
    await assert.rejects(get(path), /recursive tree/);
    assert.equal(blobs, 0);
  });
}

test('recursive hammer proof still hydrates both exact snapshots before allowing preservation', async () => {
  const { get, counts } = fixture({ recursive: true, hammer: true });
  const evidence = await fetchPrimaryChange({ ...args, get }, { fetchCiCostImpl: async () => ({ headSha: head, ok: true }) });
  assert.equal(evidence.headSha, head);
  assert.equal(evidence.primaryFiles.length, 53);
  assert.equal(evidence.finalFiles.length, 53);
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
  const reversed = { ...evidence, finalFiles: [] };
  assert.equal(checkPrimaryChange(reversed, head).ok, false);
  assert.equal(counts.tree, 6, 'base snapshot requests coalesce across primary and final comparisons');
  assert.equal(counts.blob, 106, 'identical SHA-addressed blobs coalesce');
});

test('recursive snapshot verification cannot continue past the global history deadline', async () => {
  let treeReads = 0;
  const schedule = { elapsedMs: 0, async read(stage) {
    if (stage === 'tree' && ++treeReads === 3) this.elapsedMs = 90000;
  } };
  const { get, counts } = fixture({ recursive: true, schedule });
  await assert.rejects(get(path), { code: 'HISTORY_READ_TIMEOUT' });
  assert.ok(treeReads >= 3 && treeReads <= 4, 'deadline expires on the first recursive request');
  assert.equal(counts.blob, 0);
  assert.equal(counts.diff, 0);
});

test('recursive evidence coalesces completed requests only within its credential identity', async () => {
  const { transport, counts } = fixture({ recursive: true });
  const reader = token => createHistoryReader({ execGhWithRetryImpl: transport, env: { GH_TOKEN: token } });
  await withClosureEvaluationReadCache(async () => {
    const first = await reader('offline-fixture-one')(path);
    const second = await reader('offline-fixture-two')(path);
    assert.deepEqual(first, second);
    assert.equal(counts.tree, 8);
    assert.equal(counts.blob, 212);
    assert.deepEqual(await reader('offline-fixture-one')(path), first);
    assert.equal(counts.tree, 8, 'same-credential completed recursive evidence reuses its immutable cache');
    assert.equal(counts.blob, 212);
    assert.equal(counts.compare, 2);
  });
});
