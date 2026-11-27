import './helpers/load-aware-timeout-fixture.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { currentGitHubBudgetScope } from '../src/rate-limit-throttle.mjs';
import { createHistoryReader } from '../src/ama/history-reader.mjs';
import { execHistoryFile } from '../src/ama/history-child.mjs';
import { checkPrimaryChange, fetchPrimaryChange, fetchPrimaryChangeContext } from '../src/ama/primary-change.mjs';

// Public, generated Git objects. Only the three comparison sizes and topology
// are modeled on the incident. The clock charges aggregate work after admission
// and gives repeatable results independent of host/child scheduling.
function mergedMain({ budget = 90000, reverted = false, legacy = false, invalidTree = false, invalidPage = false } = {}) {
  const objects = new Map(), commits = new Map();
  const objectSha = (type, body) => createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
  function tree(files) {
    const nodes = new Map();
    for (const [path, bytes] of files) {
      const [, dir, name] = /^(?:([^/]+)\/)?(.+)$/.exec(path);
      if (dir) {
        if (!nodes.has(dir)) nodes.set(dir, new Map());
        nodes.get(dir).set(name, bytes);
      } else nodes.set(name, bytes);
    }
    const entries = [], recursive = [];
    const rows = [...nodes.keys()].sort((a, b) => {
      const order = name => Buffer.from(nodes.get(name) instanceof Map ? `${name}/` : name);
      return Buffer.compare(order(a), order(b));
    }).map(path => {
      const value = nodes.get(path);
      const directory = value instanceof Map;
      const body = directory ? null : Buffer.from(value);
      const sha = directory ? tree(value) : objectSha('blob', body);
      if (!directory) objects.set(`git/blobs/${sha}`, { size: body.length, encoding: 'base64', content: body.toString('base64') });
      const entry = { path, sha, type: directory ? 'tree' : 'blob', mode: directory ? '040000' : '100644' };
      entries.push(entry);
      recursive.push(entry);
      if (directory) recursive.push(...objects.get(`git/trees/${sha}?recursive=1`).tree.map(row => ({ ...row, path: `${path}/${row.path}` })));
      return Buffer.concat([Buffer.from(`${directory ? '40000' : '100644'} ${path}\0`), Buffer.from(sha, 'hex')]);
    });
    const sha = objectSha('tree', Buffer.concat(rows));
    objects.set(`git/trees/${sha}`, { sha, tree: entries, truncated: false });
    objects.set(`git/trees/${sha}?recursive=1`, { sha, tree: recursive, truncated: false });
    return sha;
  }
  function commit(treeSha, parents, message) {
    const identity = 'Example <example@example.invalid> 1700000000 +0000';
    const lines = [`tree ${treeSha}`, ...parents.map(sha => `parent ${sha}`), `author ${identity}`, `committer ${identity}`, '', message, ''];
    const sha = objectSha('commit', Buffer.from(lines.join('\n')));
    commits.set(sha, { sha, parents: parents.map(sha => ({ sha })), commit: { message: `${message}\n` } });
    objects.set(`git/trees/${sha}`, objects.get(`git/trees/${treeSha}`));
    return sha;
  }
  const upstream = Array.from({ length: 970 }, (_, index) => `${index < 225 ? 'tests/' : 'src/'}upstream-${index}.txt`);
  const authored = Array.from({ length: 25 }, (_, index) => index === 0 ? 'alembic/versions/100_example.py'
    : `${index < 3 ? 'tests' : 'src'}/feature-${index}.txt`);
  const initial = new Map([...upstream.slice(275), ...authored].map(path => [path, `old ${path}\nunchanged\n`]));
  const authorTree = tree(new Map([...initial, ...authored.slice(0, 18).map(path => [path, `author ${path}\nunchanged\n`])]));
  const mainFiles = new Map([...initial, ...upstream.map(path => [path, `main ${path}\nunchanged\n`])]);
  const mainTree = tree(mainFiles), initialTree = tree(initial);
  const fork = commit(initialTree, [], 'fork');
  let liveBase = fork;
  for (let index = 0; index < 97; index++) liveBase = commit(mainTree, [liveBase], `main ${index}`);
  const builderStart = commit(authorTree, [fork], 'add example migration and feature');
  const builderNext = commit(authorTree, [builderStart], 'builder follow-up');
  const primary = commit(authorTree, [builderNext], 'builder tests');
  const hammer = commit(authorTree, [primary], 'repair\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nClosed-By: hammer (adversarial-pipe-mode)');
  const finalTree = tree(new Map([...mainFiles, ...authored.map((path, index) => [path,
    reverted && index === 0 ? initial.get(path) : `${index < 18 ? 'author' : 'repair'} ${path}\nunchanged\n`])]));
  let head = commit(finalTree, [hammer, liveBase], 'integrate main');
  for (let index = 0; index < 13; index++) head = commit(finalTree, [head], `post-integration ${index}`);
  function ancestry(sha) {
    const seen = new Set();
    const add = sha => {
      if (seen.has(sha)) return;
      for (const parent of commits.get(sha).parents) add(parent.sha);
      seen.add(sha);
    };
    add(sha);
    return seen;
  }
  const counts = { compare: 0, root: 0, recursive: 0, blob: 0, live: 0, diff: 0 };
  let elapsedMs = 0;
  const repo = 'example/history';
  const reader = createHistoryReader({ contextTimeoutMs: budget, nowMs: () => elapsedMs,
    execGhWithRetryImpl: async ({ args, signal, totalTimeoutMs }) => {
      assert.ok(currentGitHubBudgetScope());
      signal.throwIfAborted();
      assert.equal(totalTimeoutMs, budget - elapsedMs);
      elapsedMs += 80;
      const path = args[1].slice(`repos/${repo}/`.length);
      let value;
      if (path.startsWith('compare/')) {
        counts.compare++;
        const [, left, right, search] = /^compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})(?:\?(.*))?$/.exec(path);
        const a = ancestry(left), b = ancestry(right);
        const mergeBase = [...b].filter(sha => a.has(sha)).at(-1);
        const range = [...b].filter(sha => !a.has(sha));
        const page = Number(new URLSearchParams(search).get('page'));
        value = { status: left === right ? 'identical' : mergeBase === left ? 'ahead' : 'diverged',
          total_commits: range.length, merge_base_commit: { sha: mergeBase } };
        if (page) value.commits = (invalidPage && right === head && left === liveBase ? [] : range.slice((page - 1) * 100, page * 100))
          .map(sha => commits.get(sha));
      } else if (path === 'pulls/42') {
        counts.live++;
        value = { head: { sha: head }, base: { sha: liveBase, ...(reverted ? { ref: 'main' } : {}) } };
      } else if (reverted && path === 'branches/main/protection/required_status_checks') {
        counts.live++;
        value = { contexts: ['fixture-check'] };
      } else if (reverted && path.includes('/check-runs?')) {
        counts.live++;
        value = { check_runs: [] };
      } else {
        counts[path.startsWith('git/blobs/') ? 'blob' : path.includes('?') ? 'recursive' : 'root']++;
        value = objects.get(path);
        if (invalidTree && path === `git/trees/${finalTree}?recursive=1`) {
          value = { ...value, tree: value.tree.filter(row => row.path !== 'src/upstream-300.txt') };
        }
      }
      assert.ok(value, `unexpected request ${path}`);
      return { stdout: JSON.stringify(value) };
    }, diffImpl: (...args) => {
      counts.diff++;
      elapsedMs += 20;
      return execHistoryFile(...args);
    } });
  // Suppressing the new capability exercises the former paginated, full-diff
  // path through the same collector and transport.
  const get = legacy ? Object.assign(path => reader(path), { metadata: reader.metadata, commitHistory: reader.commitHistory }) : reader;
  const args = { repo, prNumber: 42, headSha: head, rootDir: join(tmpdir(), randomUUID()), get };
  const options = { contextTimeoutMs: budget, fetchCiCostImpl: async () => ({ headSha: head, ok: true }) };
  return { run: (context = false) => (context ? fetchPrimaryChangeContext : fetchPrimaryChange)(args, options),
    counts, elapsed: () => elapsedMs, head, primary, fork, liveBase };
}

const metrics = f => ({ ...f.counts, elapsedMs: f.elapsed() });

test('LAC-2286 merged main: scoped replay finishes under the same context budget', async t => {
  const before = mergedMain({ legacy: true });
  const after = mergedMain();
  const timeout = await before.run(true);
  const result = await after.run(true);
  t.diagnostic(JSON.stringify({ before: metrics(before), after: metrics(after) }));
  assert.equal(timeout.historyReadTimedOut, true, timeout.reason);
  assert.equal(checkPrimaryChange(timeout, before.head).reason, 'history-read-failed');
  assert.equal(result.primaryHead, after.primary);
  assert.equal(result.mergeBase, after.fork);
  assert.equal(result.comparisonMergeBase, after.liveBase);
  assert.equal(result.completeFileLists, true);
  assert.equal(result.finalPatchesScoped, true);
  assert.equal(result.primaryFiles.length, 18);
  assert.equal(result.finalFiles.length, 995);
  assert.equal(result.finalFiles.find(file => file.filename === 'src/upstream-300.txt').patch, undefined);
  assert.match(result.finalFiles.find(file => file.filename === 'tests/upstream-1.txt').patch, /main tests/);
  assert.deepEqual(metrics(after), { compare: 5, root: 3, recursive: 3, blob: 261, live: 1, diff: 243, elapsedMs: 26700 });
  assert.equal(checkPrimaryChange(result, after.head, { strictNonBlockingRemediation: true }).ok, true);
  assert.equal(checkPrimaryChange(result, after.primary).ok, false);
});

test('LAC-2286 merged main: a reverted migration and incomplete observations still refuse', async () => {
  const reverted = mergedMain({ reverted: true });
  const evidence = await reverted.run();
  assert.equal(checkPrimaryChange(evidence, reverted.head).reason, 'primary-change-reverted');
  assert.equal(reverted.counts.live, 5, 'guard checks live PR, protection and both check runs');
  assert.equal(reverted.counts.blob, 261, 'guard base inventory does not download integrated blobs');
  const incomplete = mergedMain({ invalidTree: true });
  assert.match((await incomplete.run()).reason, /incomplete recursive tree/);
  const missingPage = mergedMain({ invalidPage: true });
  assert.match((await missingPage.run()).reason, /incomplete compare pagination/);
  assert.equal(missingPage.counts.blob, 0);
});
