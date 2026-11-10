import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHistoryReader } from '../src/ama/history-reader.mjs';
import { checkPrimaryChange, fetchPrimaryChange } from '../src/ama/primary-change.mjs';
import { primaryRenameRepository } from './helpers/primary-change.mjs';

const base = 'a'.repeat(40), head = 'c'.repeat(40);
const repo = 'fixture/repo', prNumber = 42;
const never = () => new Promise(() => {});

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
    return createHistoryReader({ contextTimeoutMs: 100, progress: { rootDir, repo, prNumber, headSha },
      env: { GH_TOKEN: `synthetic-rotated-token-${++token}`, GH_HOST: host },
      execGhWithRetryImpl: async ({ args }) => {
        if (args[1].includes('/pulls/')) { liveReads++; return { stdout: '{}' }; }
        if (++reads > maxReads) return never();
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
  const reader = () => createHistoryReader({ contextTimeoutMs: 100,
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
      if (index === 1 && stalled) return never();
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
