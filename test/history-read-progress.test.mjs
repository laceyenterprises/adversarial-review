import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHistoryReader } from '../src/ama/history-reader.mjs';
import { historyReadTimeoutError } from '../src/ama/history-read-policy.mjs';
import { checkPrimaryChange, fetchPrimaryChange } from '../src/ama/primary-change.mjs';
import { primaryRenameRepository } from './helpers/primary-change.mjs';

const base = 'a'.repeat(40), head = 'c'.repeat(40);
const repo = 'fixture/repo', prNumber = 42;
const never = () => new Promise(() => {});

function comparisonFixture(t, { durable = true, mergeBase = base } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'history-comparison-'));
  t.after(() => rmSync(rootDir, { force: true, recursive: true }));
  const counts = { tree: 0, blob: 0, diff: 0 };
  const entry = (path, sha) => ({ path, sha: sha.repeat(40), type: 'blob', mode: '100644' });
  let cachedOnly = false;
  const reader = () => createHistoryReader({ contextTimeoutMs: 10_000,
    ...(durable ? { progress: { rootDir, repo, prNumber, headSha: head } } : {}),
    execGhWithRetryImpl: async ({ args }) => {
      const path = args[1];
      let data;
      if (path.includes('/compare/')) data = { merge_base_commit: { sha: mergeBase }, status: 'ahead', total_commits: 0 };
      else {
        assert.equal(cachedOnly, false, 'projection must not walk trees or read blobs');
        if (path.includes('/git/trees/')) {
          counts.tree++;
          data = { truncated: false, tree: path.endsWith(mergeBase)
            ? [entry('old.txt', '1')] : [entry('renamed.txt', '1'), entry('chosen.txt', '2'), entry('other.txt', '3')] };
        } else {
          counts.blob++;
          data = { encoding: 'base64', content: 'eAo=', size: 2 };
        }
      }
      return { stdout: JSON.stringify(data) };
    },
    diffImpl: async () => {
      assert.equal(cachedOnly, false, 'projection must not reopen patch checkpoints');
      counts.diff++;
      return { stdout: 'diff\n@@ -0,0 +1 @@\n+x\n' };
    },
  });
  const retainProjectionsOnly = () => {
    const dir = join(rootDir, 'data', 'primary-change-history');
    for (const progress of readdirSync(dir)) for (const file of readdirSync(join(dir, progress))) {
      const path = join(dir, progress, file);
      const { readKey } = JSON.parse(readFileSync(path, 'utf8'));
      if (!readKey[1].startsWith('complete-file-') && !String(readKey[2]).includes('/compare/')) rmSync(path);
    }
    cachedOnly = true;
  };
  return { rootDir, reader, counts, retainProjectionsOnly };
}

test('mandatory snapshots reconstruct inventory even if a complete projection has lost a row', async t => {
  const f = comparisonFixture(t);
  const path = `repos/${repo}/compare/${base}...${head}`;
  const original = await f.reader().compareFiles(path);
  const store = join(f.rootDir, 'data', 'primary-change-history');
  const [progress] = readdirSync(store);
  for (const file of readdirSync(join(store, progress))) {
    const checkpoint = join(store, progress, file);
    const record = JSON.parse(readFileSync(checkpoint, 'utf8'));
    if (record.readKey[1] === 'complete-file-comparison-v1') {
      record.value.pop();
      writeFileSync(checkpoint, JSON.stringify(record));
    }
  }
  const snapshot = await f.reader().compareFiles(path, true, { reuseProjection: false });
  assert.equal(original.files.length, 3);
  assert.deepEqual(snapshot, original);
});

test('inventory predicates and boolean flags reuse inventory without poisoning complete patches', async t => {
  const f = comparisonFixture(t);
  const path = `repos/${repo}/compare/${base}...${head}`;
  const inventory = await f.reader().compareFiles(path, filename => {
    assert.ok(filename, 'scope is evaluated only on real filenames');
    return false;
  });
  assert.deepEqual(f.counts, { tree: 2, blob: 0, diff: 0 });
  f.retainProjectionsOnly();
  assert.deepEqual(await f.reader().compareFiles(path, () => false), inventory);
  assert.deepEqual(await f.reader().compareFiles(path, false), inventory);
  assert.deepEqual(await f.reader().compareFiles(`repos/${repo}/compare/${base.toUpperCase()}...${head.toUpperCase()}`, false), inventory);
  assert.equal(inventory.files.find(file => file.filename === 'renamed.txt').previous_filename, 'old.txt');
});

test('scoped comparisons project cached complete patches and preserve rename identity across SHA casing', async t => {
  const f = comparisonFixture(t);
  const path = `repos/${repo}/compare/${base}...${head}`;
  const full = await f.reader().compareFiles(`repos/${repo}/compare/${base.toUpperCase()}...${head.toUpperCase()}`);
  assert.ok(full.files.find(file => file.filename === 'other.txt').patch);
  const counts = { ...f.counts };
  f.retainProjectionsOnly();
  const scoped = await f.reader().compareFiles(path, filename => filename === 'chosen.txt');
  assert.ok(scoped.files.find(file => file.filename === 'chosen.txt').patch);
  assert.deepEqual(scoped.files.find(file => file.filename === 'other.txt'),
    { filename: 'other.txt', status: 'added', sha: '3'.repeat(40) });
  assert.deepEqual(scoped.files.find(file => file.filename === 'renamed.txt'),
    { filename: 'renamed.txt', previous_filename: 'old.txt', status: 'renamed', sha: '1'.repeat(40), additions: 0, deletions: 0 });
  const inventory = await f.reader().compareFiles(path, () => false);
  assert.ok(inventory.files.every(file => !Object.hasOwn(file, 'patch')));
  assert.deepEqual(await f.reader().compareFiles(path), full, 'projection never mutates complete evidence');
  assert.deepEqual(f.counts, counts);
});

test('cold scoped and inventory reads cannot satisfy a later complete-patch read', async t => {
  for (const scope of [false, () => false, filename => filename === 'chosen.txt']) await t.test(String(scope), async t => {
    const f = comparisonFixture(t);
    const path = `repos/${repo}/compare/${base}...${head}`;
    await f.reader().compareFiles(path, scope);
    const full = await f.reader().compareFiles(path);
    assert.ok(full.files.find(file => file.filename === 'chosen.txt').patch);
    assert.ok(full.files.find(file => file.filename === 'other.txt').patch);
    f.retainProjectionsOnly();
    assert.deepEqual(await f.reader().compareFiles(path, true), full);
  });
});

test('boolean inventory flags also work without progress and with a different merge base', async t => {
  for (const options of [{ durable: false }, { mergeBase: 'b'.repeat(40) }]) {
    const f = comparisonFixture(t, options);
    const result = await f.reader().compareFiles(`repos/${repo}/compare/${base}...${head}`, false);
    assert.equal(result.filesComplete, true);
    assert.equal(result.files.length, 3);
    assert.deepEqual(f.counts, { tree: 2, blob: 0, diff: 0 });
  }
});

test('invalid optional source inventory preserves protected history progress', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'source-inventory-progress-'));
  t.after(() => rmSync(rootDir, { force: true, recursive: true }));
  const old = 'b'.repeat(40), missing = 'd'.repeat(40);
  const compare = `repos/${repo}/compare/${base}...${head}`;
  const progress = { rootDir, repo, prNumber, headSha: head };
  const broken = { path: 'docs', type: 'tree', mode: '040000', sha: 'e'.repeat(40) };
  const responses = new Map([
    [compare, { status: 'ahead', total_commits: 0, merge_base_commit: { sha: base } }],
    [`repos/${repo}/git/trees/${base}`, { truncated: false, tree: [] }],
    [`repos/${repo}/git/trees/${head}`, { truncated: false, tree: [] }],
    [`repos/${repo}/git/trees/${old}`, { truncated: false, tree: [broken] }],
    [`repos/${repo}/git/trees/${old}?recursive=1`, { truncated: false, tree: [] }],
    [`repos/${repo}/git/trees/${missing}`, { truncated: true, tree: [] }],
  ]);
  let compareReads = 0;
  const reader = () => createHistoryReader({ progress, execGhWithRetryImpl: async ({ args }) => {
    if (args[1] === compare) compareReads++;
    assert.ok(responses.has(args[1]), args[1]);
    return { stdout: JSON.stringify(responses.get(args[1])) };
  } });
  const get = reader();
  const metadata = await get.metadata(compare);
  assert.equal(await get.exactFileChanges(repo, base, old), null);
  assert.equal(await get.exactFileChanges(repo, base, missing), null);
  assert.deepEqual(await get.metadata(compare), metadata);
  assert.deepEqual(await reader().metadata(compare), metadata);
  assert.equal(compareReads, 1);
  assert.deepEqual((await get.compareFiles(compare, false)).files, []);
});

test('HISTREADLOAD-01: a fresh reader resumes persisted pages across bounded attempts and head changes invalidate them', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'history-progress-'));
  t.after(() => rmSync(rootDir, { force: true, recursive: true }));
  const commits = Array.from({ length: 501 }, (_, index) => ({
    sha: (index + 1).toString(16).padStart(40, '0'), commit: { message: 'Synthetic change' },
    author: { login: index % 2 ? 'fixture-builder' : 'fixture-maintainer' },
  }));
  const successes = new Map();
  let liveReads = 0;
  let token = 0;
  const attempt = (headSha, maxReads, host = 'github.com') => {
    let reads = 0;
    const controller = new AbortController();
    // Interrupt at a fixed read boundary: scheduler delays must not change
    // how many pages this checkpoint-resumption fixture completes.
    return createHistoryReader({ contextTimeoutMs: 10_000, signal: controller.signal,
      progress: { rootDir, repo, prNumber, headSha },
      env: { GH_TOKEN: `synthetic-rotated-token-${++token}`, GH_HOST: host },
      execGhWithRetryImpl: async ({ args }) => {
        if (args[1].includes('/pulls/')) { liveReads++; return { stdout: '{}' }; }
        if (++reads > maxReads) {
          // Let successful sibling reads finish publishing their checkpoints.
          await new Promise(resolve => setImmediate(resolve));
          controller.abort(historyReadTimeoutError());
          return never();
        }
        const page = Number(new URLSearchParams(args[1].split('?')[1]).get('page'));
        successes.set(page, (successes.get(page) || 0) + 1);
        return { stdout: JSON.stringify({ status: 'ahead', total_commits: commits.length,
          merge_base_commit: { sha: base }, commits: commits.slice((page - 1) * 100, page * 100) }) };
      } });
  };
  const path = `repos/${repo}/compare/${base}...${head}`;
  for (let i = 0; i < 2; i++) {
    await assert.rejects(attempt(head, 2).commitHistory(path), { code: 'HISTORY_READ_TIMEOUT' });
  }
  const result = await attempt(head, 2).commitHistory(path);
  assert.deepEqual(result.commits, commits);
  assert.equal(successes.size, 6);
  assert.ok([...successes.values()].every(count => count === 1), 'completed pages are never fetched twice');
  await assert.rejects(attempt(head, 0, 'other.example.invalid').commitHistory(path), { code: 'HISTORY_READ_TIMEOUT' });
  // Even the same object-addressed path cannot reuse another head's progress.
  await assert.rejects(attempt('d'.repeat(40), 0).commitHistory(path), { code: 'HISTORY_READ_TIMEOUT' });
  const live = attempt(head, 0);
  await live(`repos/${repo}/pulls/${prNumber}`);
  await live(`repos/${repo}/pulls/${prNumber}`);
  assert.equal(liveReads, 2, 'live metadata is never checkpointed');
});

test('persisted history cannot establish a rename whose author identity is unproven', async t => {
  const fixture = primaryRenameRepository(t, { author: null, committer: null });
  const options = { fetchCiCostImpl: async () => ({ headSha: fixture.args.headSha, ok: true }) };
  const first = await fetchPrimaryChange(fixture.args, options);
  assert.equal(checkPrimaryChange(first, fixture.args.headSha).ok, false);
  const again = await fetchPrimaryChange(fixture.args, options);
  assert.equal(checkPrimaryChange(again, fixture.args.headSha).ok, false);
  assert.ok(fixture.calls.some(path => path.includes('/commits/')), 'provenance is read before refusing');
});

test('completed file comparisons survive a later diff timeout without repeating local git work', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'history-diff-progress-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const diffCalls = [0, 0];
  let stalled = true;
  const reader = () => createHistoryReader({ contextTimeoutMs: 10_000,
    progress: { rootDir, repo, prNumber, headSha: head },
    execGhWithRetryImpl: async ({ args }) => {
      const path = args[1];
      const data = path.includes('/compare/') ? {
        status: 'ahead', total_commits: 0, commits: [], merge_base_commit: { sha: base },
      } : path.includes('/git/trees/') ? { truncated: false, tree: path.endsWith(base) ? [] : [0, 1].map(index => ({
        path: `${index}.txt`, type: 'blob', mode: '100644', sha: String(index + 1).repeat(40),
      })) } : { encoding: 'base64', content: 'eAo=', size: 2 };
      return { stdout: JSON.stringify(data) };
    },
    diffImpl: async (_command, args) => {
      const index = Number(args.at(-1).split('-')[1]);
      diffCalls[index]++;
      if (index === 1 && stalled) throw Object.assign(new Error('synthetic diff timeout'), { code: 'HISTORY_READ_TIMEOUT' });
      return { stdout: 'diff\n@@ -0,0 +1 @@\n+x\n' };
    },
  });
  const path = `repos/${repo}/compare/${base}...${head}`;
  await assert.rejects(reader()(path), { code: 'HISTORY_READ_TIMEOUT' });
  stalled = false;
  assert.equal((await reader()(path)).files.length, 2);
  assert.deepEqual(diffCalls, [1, 2], 'only the unfinished comparison retries');
});

test('a mixed-author preservation collection finishes through repeated deferrals using durable progress', async t => {
  let reads = 0;
  const fixture = primaryRenameRepository(t, {
    beforeRead: async () => { if (++reads > 5) await never(); },
  });
  const options = { contextTimeoutMs: 1000,
    fetchCiCostImpl: async () => ({ headSha: fixture.args.headSha, ok: true }) };
  let evidence, attempts = 0;
  for (; attempts < 12; attempts++) {
    reads = 0;
    evidence = await fetchPrimaryChange({ ...fixture.args, get: fixture.createReader() }, options);
    if (!evidence.historyReadTimedOut) break;
    assert.equal(checkPrimaryChange(evidence, fixture.args.headSha).ok, false);
  }
  assert.ok(attempts > 0, 'fixture must exhaust at least one whole-collection budget');
  assert.ok(attempts < 12, 'bounded retries must make progress to a complete proof');
  assert.equal(checkPrimaryChange(evidence, fixture.args.headSha).ok, true, JSON.stringify(evidence));
  assert.equal(evidence.renameProofs[0].commit.sha, fixture.renameSha);
});

test('persisted verified file facts still run the preservation predicate', async t => {
  for (const changed of [false, true]) {
    const fixture = primaryRenameRepository(t, { changed });
    const options = { fetchCiCostImpl: async () => ({ headSha: fixture.args.headSha, ok: true }) };
    const first = await fetchPrimaryChange(fixture.args, options);
    const again = await fetchPrimaryChange(fixture.args, options);
    assert.equal(checkPrimaryChange(first, fixture.args.headSha).ok, !changed);
    assert.equal(checkPrimaryChange(again, fixture.args.headSha).ok, !changed);
  }
});


test('semantic compare, blob and recursive-tree failures discard checkpoints so the same head can recover', async t => {
  for (const failure of ['compare', 'blob', 'blob-with-stalled-sibling', 'recursive-tree']) await t.test(failure, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'history-invalid-progress-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    let broken = true, reads = 0;
    const directorySha = 'd'.repeat(40), blobSha = 'e'.repeat(40);
    const entry = { path: 'source.txt', type: 'blob', mode: '100644', sha: blobSha };
    const subtree = { path: 'dir', type: 'tree', mode: '040000', sha: directorySha };
    const reader = () => createHistoryReader({ contextTimeoutMs: 1000,
      progress: { rootDir, repo, prNumber, headSha: head },
      execGhWithRetryImpl: async ({ args }) => {
        reads++;
        const path = args[1];
        let data;
        if (broken && failure === 'blob-with-stalled-sibling' && path.endsWith('f'.repeat(40))) return never();
        if (path.includes('/compare/')) data = { status: 'ahead', total_commits: 0,
          commits: broken && failure === 'compare' ? [{ sha: head }] : [], merge_base_commit: { sha: base } };
        else if (path.endsWith('?recursive=1')) data = broken && failure === 'recursive-tree'
          ? { truncated: false, tree: [subtree] } : { truncated: true, tree: [] };
        else if (path.includes('/git/trees/')) data = { truncated: false,
          tree: path.endsWith(base) ? [] : path.endsWith(directorySha) ? [entry]
            : failure === 'recursive-tree' ? [subtree] : failure === 'blob-with-stalled-sibling'
              ? [entry, { ...entry, path: 'stalled.txt', sha: 'f'.repeat(40) }] : [entry] };
        else data = { encoding: 'base64', content: 'eAo=', size: broken && failure.startsWith('blob') ? 3 : 2 };
        return { stdout: JSON.stringify(data) };
      }, diffImpl: async () => ({ stdout: 'diff\n@@ -0,0 +1 @@\n+x\n' }),
    });
    const path = `repos/${repo}/compare/${base}...${head}`;
    await assert.rejects(reader()(path), { code: 'HISTORY_READ_INVALID' });
    const dir = join(rootDir, 'data', 'primary-change-history');
    assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], [], 'invalid history left no sticky checkpoints');
    const previousReads = reads;
    broken = false;
    assert.equal((await reader()(path)).files.length, failure === 'blob-with-stalled-sibling' ? 2 : 1);
    assert.ok(reads > previousReads, 'retry fetched corrected upstream data');
  });
});
